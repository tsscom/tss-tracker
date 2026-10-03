import { MAX_ATTACHMENT_BYTES, INCIDENT_TYPES, INCIDENT_SEVERITIES, QUEUE_LABELS, sanitizeMobileSnapshot, createOperation, addToQueue, canSendOperation, prepareRequest, acknowledgeOperation, failedOperation, recoverQueue, reviewConflict } from './mobile-model.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const date = value => value ? new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value.length === 10 ? value + 'T12:00:00' : value)) : 'Por confirmar';
const time = value => value ? new Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Sem atualização';
const isPending = item => item.status !== 'sent' && !item.reviewedByOperationId;
let database, profile, sessionUser, csrfToken = '', authenticated = false, connected = navigator.onLine, sending = false, currentTab = 'jobs', formContext, formBusy = false, signatureDirty = false, signatureDrawing = false, installPrompt, toastTimer;
let storageChain = Promise.resolve();

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function notify(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, 6500); }
function notice(message = '', error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = !message; }

async function openDatabase() {
  if (!window.indexedDB) throw new Error('O navegador não permite guardar registos neste dispositivo. Use um navegador atualizado fora do modo privado.');
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tss-driver-private-v1', 1);
    request.onupgradeneeded = () => { const db = request.result; db.createObjectStore('profiles', { keyPath: 'userId' }); db.createObjectStore('meta'); };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
    request.onerror = () => reject(new Error('Não foi possível abrir o armazenamento local.'));
    request.onblocked = () => reject(new Error('Feche outras janelas da aplicação para atualizar o armazenamento.'));
  });
}
function dbRead(store, key) { return new Promise((resolve, reject) => { const tx = database.transaction(store, 'readonly'); const request = tx.objectStore(store).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Não foi possível ler os registos locais.')); }); }
function updateProfile(transform) {
  const run = async () => {
    if (!database || !profile?.userId) throw new Error('O armazenamento local não está disponível. O registo não foi guardado.');
    const userId = profile.userId;
    const result = await new Promise((resolve, reject) => {
      const tx = database.transaction(['profiles', 'meta'], 'readwrite'); const store = tx.objectStore('profiles'); const request = store.get(userId); let changed;
      request.onsuccess = () => {
        try { changed = transform(request.result ?? { userId, snapshot: profile.snapshot, queue: [] }); changed.userId = userId; store.put(changed); tx.objectStore('meta').put(userId, 'activeUserId'); }
        catch (error) { tx.abort(); reject(error); }
      };
      tx.oncomplete = () => resolve(changed);
      tx.onerror = tx.onabort = () => reject(new Error('Não foi possível guardar. O armazenamento pode estar cheio; conserve o comprovativo e contacte operações.'));
    });
    if (profile?.userId === userId) profile = result;
    return result;
  };
  const result = storageChain.then(run, run); storageChain = result.catch(() => {}); return result;
}
async function deleteLocalUser(userId, remoteEnded) {
  await storageChain;
  await new Promise((resolve, reject) => { const tx = database.transaction(['profiles', 'meta'], 'readwrite'); tx.objectStore('profiles').delete(userId); tx.objectStore('meta').delete('activeUserId'); if (!remoteEnded) tx.objectStore('meta').put(true, 'logoutPending'); else tx.objectStore('meta').delete('logoutPending'); tx.oncomplete = resolve; tx.onerror = () => reject(new Error('Não foi possível apagar os dados locais.')); });
}
async function clearLogoutIntent() { await new Promise((resolve, reject) => { const tx = database.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('logoutPending'); tx.oncomplete = resolve; tx.onerror = reject; }); }
async function api(path, method = 'GET', body) {
  let response;
  try { response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
  catch { connected = false; renderConnection(); throw Object.assign(new Error('Sem ligação ao servidor. O registo fica neste dispositivo.'), { status: 0 }); }
  connected = true; renderConnection();
  const result = await response.json().catch(() => ({ error: 'Resposta inválida do servidor.' }));
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) { authenticated = false; csrfToken = ''; }
    throw Object.assign(new Error(result.error ?? 'A operação não foi confirmada.'), { status: response.status });
  }
  if (result.csrfToken) csrfToken = result.csrfToken;
  return result;
}
function renderConnection() { $('connection').textContent = connected ? authenticated ? 'Ligado' : 'Confirmar conta' : 'Sem ligação'; $('connection').classList.toggle('online', connected && authenticated); $('connection').classList.toggle('offline', !connected); }
function showAuth(message = '') {
  $('driver-view').hidden = true; $('bottom-nav').hidden = true; $('auth-view').hidden = false; $('password').value = '';
  $('auth-error').textContent = message; $('auth-error').hidden = !message;
  $('offline-open').hidden = !(profile?.snapshot && !connected);
  renderConnection();
}
function showDriver() {
  $('auth-view').hidden = true; $('driver-view').hidden = false; $('bottom-nav').hidden = false;
  $('greeting-title').textContent = `Olá, ${(profile.snapshot.user.name ?? 'motorista').split(' ')[0]}.`;
  $('greeting-meta').textContent = authenticated ? 'Os seus serviços, com confirmação da TSS.' : 'Últimos dados guardados · identidade por confirmar.';
  if (!authenticated) notice('Modo sem ligação. Pode guardar registos pendentes; para enviar, entre novamente com esta mesma conta.');
  render(); renderConnection();
}
async function refreshWorkspace() {
  const workspace = await api('/api/mobile/workspace');
  const snapshot = sanitizeMobileSnapshot(workspace);
  if (sessionUser?.id !== snapshot.user.id) throw new Error('A conta mudou. Entre novamente antes de continuar.');
  const loaded = await dbRead('profiles', snapshot.user.id);
  profile = loaded ?? { userId: snapshot.user.id, snapshot, queue: [] };
  await updateProfile(current => ({ ...current, snapshot, queue: recoverQueue(current.queue ?? [], snapshot.user.id) }));
  showDriver();
  if (authenticated) notice('');
}
async function verifySession() {
  const session = await api('/api/session');
  if (!session.user) { authenticated = false; csrfToken = ''; throw Object.assign(new Error('Entre novamente para confirmar a identidade e enviar os registos.'), { status: 401 }); }
  if (profile?.userId && session.user.id !== profile.userId) { authenticated = false; throw Object.assign(new Error('Os registos pendentes pertencem a outra conta. Entre com o utilizador que os guardou.'), { status: 401 }); }
  sessionUser = session.user; csrfToken = session.csrfToken; authenticated = true; renderConnection(); return session.user;
}
async function startup() {
  try { database = await openDatabase(); const active = await dbRead('meta', 'activeUserId'); if (active) { profile = await dbRead('profiles', active); if (profile) await updateProfile(current => ({ ...current, queue: recoverQueue(current.queue ?? [], active) })); } }
  catch (error) { showAuth(error.message); $('login-button').disabled = true; return; }
  try {
    const session = await api('/api/session');
    if (await dbRead('meta', 'logoutPending')) {
      if (session.user) { csrfToken = session.csrfToken; await api('/api/logout', 'POST', {}); }
      await clearLogoutIntent(); authenticated = false; csrfToken = ''; showAuth(); return;
    }
    if (session.user) { sessionUser = session.user; csrfToken = session.csrfToken; authenticated = true; await refreshWorkspace(); }
    else showAuth(session.setupRequired ? 'O gerente deve criar primeiro a sua conta na TSS Gestão e atribuir uma conta ao motorista.' : '');
  } catch (error) { authenticated = false; showAuth(error.message); }
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (formBusy) return; formBusy = true; $('login-button').disabled = true; $('auth-error').hidden = true;
  const password = $('password').value; $('password').value = '';
  try {
    const session = await api('/api/login', 'POST', { username: $('username').value.trim(), password });
    await clearLogoutIntent();
    sessionUser = session.user; csrfToken = session.csrfToken; authenticated = true;
    // Each account opens its own partition. Other accounts' queues are never sent.
    profile = undefined; await refreshWorkspace();
    notify('Conta confirmada. Os envios pendentes aguardam a sua confirmação.');
  } catch (error) { authenticated = false; showAuth(error.message); }
  finally { formBusy = false; $('login-button').disabled = false; }
});
$('offline-open').addEventListener('click', () => { if (profile?.snapshot && !connected) { authenticated = false; showDriver(); } });
$('refresh-button').addEventListener('click', async () => { if (sending) return; try { await verifySession(); await refreshWorkspace(); notify('Serviços atualizados.'); } catch (error) { notice(error.message, error.status !== 0); if (error.status === 401) showAuth(error.message); } });

function stateClass(status) { return status === 'Em curso' ? 'state-active' : status === 'Concluído' ? 'state-complete' : status === 'Cancelado' ? 'state-cancel' : ''; }
function mapLink(address) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address ?? '')}`; }
const option = (value, label) => `<option value="${esc(value)}">${esc(label)}</option>`;
function jobCard(job) {
  const pending = profile.queue.filter(item => item.jobId === job.id && isPending(item));
  const pendingAction = pending.some(item => item.kind === 'job-action');
  let actions = '', hint = '';
  if (job.status === 'Agendado') {
    const allowed = !!job.dispatchedAt && !pendingAction && (!job.allowedActions || job.allowedActions.includes('start'));
    actions = `<button class="button primary" type="button" data-action="start" data-id="${esc(job.id)}" ${allowed ? '' : 'disabled'}>Iniciar transporte <span aria-hidden="true">→</span></button>`;
    if (!job.dispatchedAt) hint = 'Aguarda autorização de saída por operações.';
  } else if (job.status === 'Em curso') actions = `<button class="button primary" type="button" data-action="deliver" data-id="${esc(job.id)}" ${pendingAction || job.allowedActions && !job.allowedActions.includes('deliver') ? 'disabled' : ''}>Registar entrega <span aria-hidden="true">✓</span></button>`;
  else if (job.status === 'Concluído' && !job.pod) actions = `<button class="button primary" type="button" data-action="registerPod" data-id="${esc(job.id)}" ${pendingAction || job.allowedActions && !job.allowedActions.includes('registerPod') ? 'disabled' : ''}>Registar comprovativo</button>`;
  if (job.status !== 'Cancelado') actions += `<button class="button secondary icon-action" type="button" data-action="incident" data-id="${esc(job.id)}" aria-label="Registar ocorrência no serviço ${esc(job.reference)}">!</button><button class="button secondary icon-action" type="button" data-action="document" data-id="${esc(job.id)}" aria-label="Anexar documento ao serviço ${esc(job.reference)}">＋</button>`;
  const cargo = job.cargo || job.instructions ? `<p class="cargo">${esc(job.cargo || 'Instruções do serviço')}${job.pallets ? ` · ${esc(job.pallets)} paletes` : ''}${job.weightKg ? ` · ${esc(job.weightKg)} kg` : ''}${job.instructions ? `<br>${esc(job.instructions)}` : ''}</p>` : '';
  const operationalNote = job.pod ? 'Comprovativo confirmado ✓' : job.status === 'Em curso' ? 'Entrega por confirmar' : job.status === 'Concluído' ? 'Comprovativo por registar' : job.dispatchedAt ? 'Saída autorizada' : 'Aguarda expedição';
  return `<article class="job-card"><div class="job-card-head"><div><p class="job-reference">${esc(job.reference)}</p><h3>${esc(job.customer)}</h3></div><span class="state ${stateClass(job.status)}">${esc(job.status)}</span></div><div class="route"><div class="route-stop"><p class="route-label">RECOLHA</p><p class="route-address">${esc(job.pickup)}</p><p class="route-meta">${esc(date(job.pickupDate))}${job.pickupTime ? ` · ${esc(job.pickupTime)}` : ''}</p><a class="route-map" href="${mapLink(job.pickup)}" target="_blank" rel="noopener noreferrer">Abrir no mapa ↗</a></div><div class="route-stop destination"><p class="route-label">ENTREGA</p><p class="route-address">${esc(job.delivery)}</p><p class="route-meta">${esc(date(job.deliveryDate))}${job.deliveryTime ? ` · ${esc(job.deliveryTime)}` : ''}</p><a class="route-map" href="${mapLink(job.delivery)}" target="_blank" rel="noopener noreferrer">Abrir no mapa ↗</a></div></div>${cargo}<div class="job-info"><span>Viatura <strong>${esc(job.vehicle || 'Por atribuir')}</strong></span><span>${operationalNote}</span></div>${pending.length ? `<p class="pending-dot">${pending.length} registo${pending.length > 1 ? 's' : ''} por confirmar</p>` : ''}${hint ? `<p class="job-message">${hint}</p>` : ''}${actions ? `<div class="job-actions">${actions}</div>` : ''}</article>`;
}
function empty(title, message) { return `<div class="empty-state"><span class="empty-icon" aria-hidden="true">▤</span><h3>${esc(title)}</h3><p>${esc(message)}</p></div>`; }
function renderJobs() {
  const jobs = profile.snapshot.jobs;
  $('job-count').textContent = jobs.length; $('active-count').textContent = jobs.filter(job => job.status === 'Em curso').length;
  $('pending-count').textContent = profile.queue.filter(isPending).length;
  $('snapshot-time').textContent = 'Atualizado ' + time(profile.snapshot.updatedAt);
  const terms = fold($('job-search').value).trim().split(/\s+/).filter(Boolean), status = $('job-status').value;
  const selected = jobs.filter(job => (!status || job.status === status) && terms.every(term => fold([job.reference, job.customer, job.pickup, job.delivery, job.vehicle].join(' ')).includes(term))).sort((first, second) => (first.pickupDate ?? '').localeCompare(second.pickupDate ?? ''));
  $('job-list').innerHTML = selected.length ? selected.map(jobCard).join('') : empty('Sem serviços nesta lista', jobs.length ? 'Ajuste a pesquisa ou o estado selecionado.' : 'Operações atribui os serviços à sua conta de motorista. Atualize quando receber uma nova atribuição.');
}
function operationTitle(item) { return item.kind === 'attachment' ? ({ 'pod-photo': 'Fotografia de entrega', signature: 'Assinatura do destinatário', document: 'Documento do serviço', 'incident-photo': 'Fotografia da ocorrência' }[item.payload.kind]) : item.kind === 'incident' ? 'Ocorrência · ' + INCIDENT_TYPES[item.payload.type] : ({ start: 'Início do transporte', deliver: 'Comprovativo de entrega', registerPod: 'Comprovativo do serviço' }[item.payload.action]); }
function renderQueue() {
  const count = profile.queue.filter(isPending).length;
  $('queue-badge').textContent = count; $('queue-badge').hidden = !count; $('sync-button').disabled = sending || !count;
  $('sync-button').textContent = sending ? 'A enviar…' : 'Confirmar conta e enviar';
  $('queue-list').innerHTML = profile.queue.length ? [...profile.queue].reverse().map(item => {
    const job = profile.snapshot.jobs.find(job => job.id === item.jobId);
    const detail = item.kind === 'attachment' ? item.payload.name : item.kind === 'incident' ? item.payload.description : item.payload.pod ? `${item.payload.pod.recipient} · ${item.payload.pod.reference}` : item.status === 'sent' ? 'Início confirmado pela TSS.' : 'Aguarda confirmação do servidor.';
    const review = item.status === 'conflict' && item.kind === 'job-action' && !item.reviewedByOperationId ? `<div class="queue-actions"><button class="button secondary" type="button" data-review="${esc(item.operationId)}">Atualizar e rever</button></div>` : '';
    return `<article class="queue-card ${esc(item.status)}"><div class="queue-card-header"><h3>${esc(operationTitle(item))}</h3><span class="state">${esc(item.reviewedByOperationId ? 'Revisto' : QUEUE_LABELS[item.status])}</span></div><p>${esc(job?.reference ?? 'Serviço atribuído')} · ${esc(time(item.createdAt))}</p><p>${esc(detail)}</p>${item.error ? `<p class="error">${esc(item.error)}</p>` : ''}${review}</article>`;
  }).join('') : empty('Tudo em dia', 'Os registos que guardar aparecem aqui, com confirmação individual de envio.');
  const incidents = [...profile.snapshot.incidents].reverse().slice(0, 20);
  $('incident-history').hidden = !incidents.length;
  $('incident-list').innerHTML = incidents.map(incident => `<article class="queue-card"><div class="queue-card-header"><h3>${esc(INCIDENT_TYPES[incident.type] ?? incident.type)} · ${esc(INCIDENT_SEVERITIES[incident.severity] ?? incident.severity)}</h3><span class="state">${esc(incident.status)}</span></div><p>${esc(profile.snapshot.jobs.find(job => job.id === incident.jobId)?.reference ?? 'Serviço')} · ${esc(time(incident.createdAt))}</p><p>${esc(incident.description)}</p></article>`).join('');
  const attachments = [...profile.snapshot.attachments].reverse().slice(0, 20);
  $('attachment-history').hidden = !attachments.length;
  $('attachment-list').innerHTML = attachments.map(attachment => `<article class="queue-card sent"><div class="queue-card-header"><h3>${esc(attachment.name)}</h3><span class="state">Confirmado</span></div><p>${esc(profile.snapshot.jobs.find(job => job.id === attachment.jobId)?.reference ?? 'Serviço')} · ${esc(time(attachment.createdAt))}</p><a class="text-link" href="/api/attachments/${esc(attachment.id)}" target="_blank" rel="noopener noreferrer">Abrir documento ↗</a></article>`).join('');
}
function renderAccount() {
  const user = profile.snapshot.user; $('account-name').textContent = user.name; $('account-username').textContent = user.username;
  $('account-avatar').textContent = user.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  $('install-description').textContent = ios ? 'No Safari, toque em Partilhar → Adicionar ao ecrã principal. Abra depois o ícone TSS Motorista.' : 'No Chrome ou Edge, abra o menu → Instalar aplicação ou Adicionar ao ecrã principal.';
  $('secure-note').textContent = window.isSecureContext ? 'Ligação segura disponível. Abra a aplicação uma vez com rede para preparar o acesso sem ligação.' : 'A instalação e o acesso sem ligação precisam de HTTPS num endereço de rede. O endereço HTTP de outro computador não é uma ligação segura para instalar a aplicação.';
  $('secure-note').classList.toggle('install-alert', !window.isSecureContext);
  $('install-button').hidden = !installPrompt;
}
function render() {
  if (!profile?.snapshot) return;
  renderJobs(); renderQueue(); renderAccount();
  for (const tab of ['jobs', 'queue', 'account']) $(`${tab}-view`).hidden = currentTab !== tab;
  document.querySelectorAll('[data-tab]').forEach(button => { const selected = button.dataset.tab === currentTab; button.classList.toggle('active', selected); button.setAttribute('aria-current', selected ? 'page' : 'false'); });
}
document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => { currentTab = button.dataset.tab; render(); window.scrollTo({ top: 0, behavior: 'auto' }); }));
$('job-search').addEventListener('input', renderJobs); $('job-status').addEventListener('change', renderJobs);

function field(id, label, attributes = '', hint = '') { return `<div class="field"><label for="${id}">${label}</label><input id="${id}" ${attributes}>${hint ? `<span class="field-hint">${hint}</span>` : ''}</div>`; }
function photoField(id, label) { return field(id, label, 'type="file" accept="image/*" capture="environment"', 'Opcional. A imagem é reduzida neste dispositivo antes de enviar; máximo 3 MB.'); }
function signatureField() { return '<div class="field"><label for="signature">Assinatura do destinatário · opcional</label><div class="signature-box"><canvas id="signature" aria-label="Área para assinar com o dedo"></canvas><div class="signature-footer"><span>Peça ao destinatário para assinar.</span><button type="button" id="clear-signature">Limpar</button></div></div><span class="field-hint">A assinatura é uma imagem de evidência; não é uma assinatura digital certificada.</span></div>'; }
function openAction(job, action, reviewOperation) {
  if (sending || formBusy) { notify('Aguarde a conclusão do envio.'); return; }
  formContext = { job, action, reviewOperation }; $('dialog-reference').textContent = job.reference; $('dialog-error').hidden = true;
  $('dialog-title').textContent = ({ start: 'Iniciar transporte', deliver: 'Registar entrega', registerPod: 'Guardar comprovativo', incident: 'Registar ocorrência', document: 'Anexar documento' }[action]);
  $('dialog-hint').textContent = reviewOperation ? 'Reveja os dados perante o serviço atualizado. Ao confirmar será criado um novo pedido; o conflito anterior fica preservado.' : ({ start: 'Confirme o início deste transporte. O registo fica pendente até a TSS confirmar.', deliver: 'Utilize a referência do comprovativo original. A entrega só fica concluída após confirmação da TSS.', registerPod: 'Utilize a referência do comprovativo original. O registo fica pendente até a TSS confirmar.', incident: 'Descreva a situação e o apoio necessário. Operações recebe o registo depois de confirmado o envio.', document: 'Junte um documento deste serviço. O ficheiro fica neste dispositivo até a TSS confirmar a receção.' }[action]);
  $('save-action').textContent = 'Guardar registo';
  if (action === 'start') $('dialog-fields').innerHTML = `<p class="section-note">Confirme que vai iniciar o serviço de ${esc(job.pickup)} para ${esc(job.delivery)} com a viatura ${esc(job.vehicle)}. A autorização de saída será novamente verificada pela TSS.</p>`;
  else if (['deliver', 'registerPod'].includes(action)) $('dialog-fields').innerHTML = field('pod-recipient', 'Nome do destinatário', 'required maxlength="120" autocomplete="name"') + field('pod-reference', 'Referência do comprovativo', 'required maxlength="180" placeholder="Ex.: CMR-2026-045"', 'Obrigatória, mesmo quando junta uma fotografia ou assinatura.') + (reviewOperation ? '' : photoField('pod-photo', 'Fotografia do comprovativo') + signatureField());
  else if (action === 'incident') $('dialog-fields').innerHTML = `<div class="field"><label for="incident-type">Tipo de ocorrência</label><select id="incident-type">${Object.entries(INCIDENT_TYPES).map(([value, label]) => option(value, label)).join('')}</select></div><div class="field"><label for="incident-severity">Gravidade</label><select id="incident-severity">${Object.entries(INCIDENT_SEVERITIES).map(([value, label]) => option(value, label)).join('')}</select></div><div class="field"><label for="incident-description">O que aconteceu?</label><textarea id="incident-description" required minlength="10" maxlength="2000" placeholder="Local, situação e apoio necessário…"></textarea></div>${photoField('incident-photo', 'Fotografia da ocorrência')}<p class="fine-print">Em caso de emergência, use o telefone e contacte os serviços adequados. Uma ocorrência pendente não avisa operações enquanto não for enviada.</p>`;
  else $('dialog-fields').innerHTML = field('document-file', 'Documento do serviço', 'type="file" accept="image/*,application/pdf" required', 'Imagem ou PDF. Fotografias são reduzidas; PDF até 3 MB.');
  if (reviewOperation?.payload.pod) { $('pod-recipient').value = reviewOperation.payload.pod.recipient; $('pod-reference').value = reviewOperation.payload.pod.reference; }
  $('action-dialog').showModal(); if ($('signature')) setupSignature();
}
function closeAction() { if (formBusy) return; $('action-dialog').close(); $('action-form').reset(); $('dialog-fields').replaceChildren(); formContext = undefined; signatureDirty = false; }
$('close-dialog').addEventListener('click', closeAction); $('cancel-dialog').addEventListener('click', closeAction);
$('action-dialog').addEventListener('cancel', event => { if (formBusy) event.preventDefault(); else closeAction(); });
$('job-list').addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (!button) return; const job = profile.snapshot.jobs.find(job => job.id === button.dataset.id); if (job) openAction(job, button.dataset.action); });

function setupSignature() {
  const canvas = $('signature'), ratio = Math.min(window.devicePixelRatio || 1, 2); const width = canvas.getBoundingClientRect().width;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(150 * ratio);
  const context = canvas.getContext('2d'); context.scale(ratio, ratio); context.fillStyle = 'white'; context.fillRect(0, 0, width, 150); context.strokeStyle = '#193652'; context.lineWidth = 2.2; context.lineCap = 'round'; context.lineJoin = 'round'; signatureDirty = false;
  const point = event => { const rect = canvas.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; };
  canvas.addEventListener('pointerdown', event => { signatureDrawing = true; signatureDirty = true; canvas.setPointerCapture(event.pointerId); context.beginPath(); context.moveTo(...point(event)); event.preventDefault(); });
  canvas.addEventListener('pointermove', event => { if (!signatureDrawing) return; context.lineTo(...point(event)); context.stroke(); event.preventDefault(); });
  const finish = () => { signatureDrawing = false; }; canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
  $('clear-signature').addEventListener('click', () => { context.fillStyle = 'white'; context.fillRect(0, 0, width, 150); signatureDirty = false; });
}
const blobBase64 = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Não foi possível ler o ficheiro.')); reader.readAsDataURL(blob); });
const canvasBlob = (canvas, type = 'image/jpeg', quality = .8) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Não foi possível preparar a imagem.')), type, quality));
async function prepareImage(file) {
  if (!file.type.startsWith('image/') || file.size > 25 * 1024 * 1024) throw new Error('Escolha uma fotografia até 25 MB para reduzir.');
  let image, url;
  try {
    if (window.createImageBitmap) image = await createImageBitmap(file);
    else { url = URL.createObjectURL(file); image = await new Promise((resolve, reject) => { const value = new Image(); value.onload = () => resolve(value); value.onerror = () => reject(new Error('Imagem não suportada neste navegador. Use JPEG ou PNG.')); value.src = url; }); }
    if (image.width * image.height > 80_000_000) throw new Error('A fotografia é demasiado grande. Escolha uma imagem de menor resolução.');
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height)); const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale)); const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let blob = await canvasBlob(canvas);
    if (blob.size > MAX_ATTACHMENT_BYTES) blob = await canvasBlob(canvas, 'image/jpeg', .55);
    if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('A imagem continua acima de 3 MB. Escolha uma imagem mais pequena.');
    return { mimeType: 'image/jpeg', dataBase64: await blobBase64(blob) };
  } finally { image?.close?.(); if (url) URL.revokeObjectURL(url); }
}
async function filePayload(jobId, kind, file) {
  if (!file) return null;
  if ((file.type === 'application/pdf' || !file.type && /\.pdf$/i.test(file.name)) && kind === 'document') {
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('O PDF pode ter até 3 MB.');
    const header = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...header) !== '%PDF-') throw new Error('O ficheiro selecionado não contém um PDF válido.');
    return { jobId, kind, name: file.name.slice(0, 160), mimeType: 'application/pdf', dataBase64: await blobBase64(file) };
  }
  const image = await prepareImage(file);
  return { jobId, kind, name: file.name.replace(/\.[^.]+$/, '').slice(0, 140) + '.jpg', ...image };
}

$('action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (formBusy || !formContext) return; formBusy = true; $('save-action').disabled = true; $('dialog-error').hidden = true;
  try {
    const { job, action, reviewOperation } = formContext; const userId = profile.userId; const prepared = [];
    if (action === 'incident') {
      const photo = await filePayload(job.id, 'incident-photo', $('incident-photo').files[0]); if (photo) prepared.push({ kind: 'attachment', payload: photo });
      prepared.push({ kind: 'incident', payload: { jobId: job.id, type: $('incident-type').value, severity: $('incident-severity').value, description: $('incident-description').value } });
    } else if (action === 'document') prepared.push({ kind: 'attachment', payload: await filePayload(job.id, 'document', $('document-file').files[0]) });
    else {
      let payload = { jobId: job.id, action, version: job.version };
      if (action !== 'start') {
        payload.pod = { recipient: $('pod-recipient').value, reference: $('pod-reference').value, deliveredAt: reviewOperation?.payload.pod?.deliveredAt ?? new Date().toISOString() };
        if (!reviewOperation) {
          const photo = await filePayload(job.id, 'pod-photo', $('pod-photo').files[0]); if (photo) prepared.push({ kind: 'attachment', payload: photo });
          if (signatureDirty) { const blob = await canvasBlob($('signature'), 'image/png'); prepared.push({ kind: 'attachment', payload: { jobId: job.id, kind: 'signature', name: `assinatura-${job.reference}.png`, mimeType: 'image/png', dataBase64: await blobBase64(blob) } }); }
        }
      }
      prepared.push({ kind: 'job-action', payload, reviewOperation });
    }
    // All captures in this form are validated and written in one IndexedDB transaction.
    await updateProfile(current => {
      let queue = current.queue ?? [], dependencies = [];
      for (const item of prepared) {
        const reviewed = item.reviewOperation ? { ...item.reviewOperation, payload: { ...item.reviewOperation.payload, ...item.payload } } : undefined;
        let operation = reviewed ? reviewConflict(reviewed, job, userId, uuid()) : createOperation({ userId, kind: item.kind, payload: item.payload, operationId: uuid(), dependencies: item.kind === 'job-action' ? dependencies : [] });
        // Retain the old conflict as history before deduplication. A released
        // operational blocker may leave the job version unchanged; the explicit
        // human review still needs a NEW request rather than matching that refusal.
        if (item.reviewOperation) queue = queue.map(entry => entry.operationId === item.reviewOperation.operationId ? { ...entry, reviewedByOperationId: operation.operationId } : entry);
        const added = addToQueue(queue, operation, userId); queue = added.queue;
        if (item.kind === 'attachment' && ['pod-photo', 'signature'].includes(item.payload.kind)) dependencies.push(added.operation.operationId);
        if (item.reviewOperation) queue = queue.map(entry => entry.operationId === item.reviewOperation.operationId ? { ...entry, error: 'Revisto manualmente. Um novo pedido aguarda confirmação.', reviewedByOperationId: added.operation.operationId } : entry);
      }
      return { ...current, queue };
    });
    formBusy = false; closeAction(); render(); notify('Registo guardado neste dispositivo. A confirmação aparece em Envios.');
    if (connected && authenticated) await syncQueue();
  } catch (error) { $('dialog-error').textContent = error.message; $('dialog-error').hidden = false; }
  finally { formBusy = false; $('save-action').disabled = false; }
});
async function syncQueue() {
  if (sending || !profile?.userId) return;
  sending = true; renderQueue();
  try {
    await verifySession();
    const expectedUserId = profile.userId;
    for (const queued of [...profile.queue]) {
      if (profile.userId !== expectedUserId) break;
      let operation = profile.queue.find(item => item.operationId === queued.operationId);
      if (!canSendOperation(operation, sessionUser, authenticated, profile.queue).allowed) continue;
      const requestPayload = prepareRequest(operation, profile.queue);
      await updateProfile(current => ({ ...current, queue: current.queue.map(item => item.operationId === operation.operationId ? { ...item, status: 'sending', attempts: (item.attempts ?? 0) + 1, requestPayload } : item) }));
      operation = profile.queue.find(item => item.operationId === operation.operationId); render();
      try {
        const path = operation.kind === 'job-action' ? `/api/jobs/${operation.jobId}/actions` : operation.kind === 'attachment' ? '/api/attachments' : '/api/incidents';
        const result = await api(path, 'POST', requestPayload);
        const acknowledged = acknowledgeOperation(operation, result);
        await updateProfile(current => ({ ...current, queue: current.queue.map(item => item.operationId === operation.operationId ? acknowledged : item) }));
      } catch (error) {
        await updateProfile(current => ({ ...current, queue: current.queue.map(item => item.operationId === operation.operationId ? failedOperation(item, error.status ?? 0, error.message) : item) }));
        if (!error.status || error.status === 401 || error.status === 403) { notice(error.message, error.status !== 0); break; }
      }
      render();
    }
    if (connected && authenticated) await refreshWorkspace();
    const pending = profile.queue.filter(isPending).length;
    if (pending) notice(`${pending} registo${pending > 1 ? 's' : ''} por confirmar. Consulte Envios; conflitos exigem revisão manual.`);
    else notify('Todos os registos foram confirmados pela TSS.');
  } catch (error) { notice(error.message, error.status !== 0); if (error.status === 401) showAuth(error.message); }
  finally { sending = false; render(); }
}
$('sync-button').addEventListener('click', syncQueue);
window.addEventListener('online', () => { connected = true; renderConnection(); if (profile?.snapshot) notice('A rede voltou. Em Envios, confirme a sua conta e envie os registos pendentes.'); });
window.addEventListener('offline', () => { connected = false; authenticated = false; renderConnection(); if (profile?.snapshot) notice('Sem ligação. Pode guardar registos neste dispositivo; ainda não estão confirmados pela TSS.'); });
$('queue-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-review]'); if (!button || sending) return;
  const operation = profile.queue.find(item => item.operationId === button.dataset.review);
  try { await verifySession(); await refreshWorkspace(); const job = profile.snapshot.jobs.find(job => job.id === operation.jobId); if (!job) throw new Error('Este serviço já não está atribuído à sua conta. Contacte operações.'); reviewConflict(operation, job, profile.userId, uuid()); openAction(job, operation.payload.action, operation); }
  catch (error) { notify(error.message); }
});

$('logout-button').addEventListener('click', () => {
  if (sending) { notify('Aguarde o envio antes de sair.'); return; }
  const pending = profile.queue.filter(isPending).length;
  $('logout-description').textContent = pending ? `Existem ${pending} registos sem confirmação. Ao apagar e sair, perde estes registos neste dispositivo. Pode voltar e enviá-los primeiro.` : 'A conta deixará de apresentar serviços e comprovativos guardados neste dispositivo.';
  $('logout-dialog').showModal();
});
$('logout-cancel').addEventListener('click', () => $('logout-dialog').close());
$('logout-confirm').addEventListener('click', async () => {
  $('logout-confirm').disabled = true;
  try {
    const userId = profile.userId;
    let remoteEnded = false; try { await api('/api/logout', 'POST', {}); remoteEnded = true; } catch { /* Private local data must still be removable while offline. */ }
    await deleteLocalUser(userId, remoteEnded); profile = undefined; sessionUser = undefined; authenticated = false; csrfToken = ''; $('logout-dialog').close(); $('job-list').replaceChildren(); $('queue-list').replaceChildren(); $('account-name').textContent = ''; $('username').value = '';
    showAuth(remoteEnded ? '' : 'Os dados locais foram apagados. Sem ligação, não foi possível terminar a sessão no servidor; volte a ligar e termine a sessão antes de partilhar o dispositivo.');
  } catch (error) { notify(error.message); }
  finally { $('logout-confirm').disabled = false; }
});
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; if (profile) renderAccount(); });
$('install-button').addEventListener('click', async () => { if (!installPrompt) return; await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = undefined; renderAccount(); });
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => notify('Não foi possível preparar o acesso sem ligação. Continue com rede e confirme a configuração HTTPS.'));
startup();
