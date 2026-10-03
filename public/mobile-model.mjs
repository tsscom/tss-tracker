// Browser/Node shared offline rules. No credentials or financial fields belong here.
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 20 * 1024 * 1024;
export const MAX_QUEUE_ITEMS = 40;
export const INCIDENT_TYPES = { delay: 'Atraso', breakdown: 'Avaria', accident: 'Acidente', damage: 'Danos', other: 'Outro' };
export const INCIDENT_SEVERITIES = { low: 'Baixa', medium: 'Média', high: 'Alta' };
export const QUEUE_LABELS = { pending: 'Pendente', sending: 'A enviar', sent: 'Enviado', conflict: 'Rever conflito', auth: 'Entrar novamente', error: 'Corrigir registo' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireUuid = value => { if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Identificador inválido.'); return value; };
const cleanText = (value, label, max, min = 1) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) throw new Error(`Preencha ${label} (${min}–${max} caracteres).`);
  return value.trim();
};
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const stableJson = value => JSON.stringify(canonical(value));

export function sanitizeMobileJob(job) {
  requireUuid(job.id);
  if (!Number.isSafeInteger(job.version) || job.version < 1) throw new Error('Versão do serviço inválida.');
  const fields = ['id', 'reference', 'customer', 'pickup', 'delivery', 'pickupDate', 'deliveryDate', 'pickupTime', 'deliveryTime', 'driver', 'vehicle', 'status', 'version', 'dispatchedAt', 'startedAt', 'completedAt', 'cargo', 'weightKg', 'pallets', 'instructions', 'driverUserId'];
  const result = Object.fromEntries(fields.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  if (Array.isArray(job.allowedActions)) result.allowedActions = job.allowedActions.filter(action => ['start', 'deliver', 'registerPod'].includes(action));
  if (typeof job.cancellationPending === 'boolean') result.cancellationPending = job.cancellationPending;
  if (job.dispatchReadiness) result.dispatchReadiness = { state: String(job.dispatchReadiness.state ?? ''), ready: job.dispatchReadiness.ready === true, blockers: (job.dispatchReadiness.blockers ?? []).map(blocker => ({ code: String(blocker.code ?? ''), label: String(blocker.label ?? '') })) };
  if (job.pod) result.pod = Object.fromEntries(['recipient', 'reference', 'deliveredAt', 'attachmentIds'].filter(key => job.pod[key] !== undefined).map(key => [key, job.pod[key]]));
  return structuredClone(result);
}

export function sanitizeMobileSnapshot(workspace) {
  const user = workspace.user;
  requireUuid(user?.id);
  const result = {
    user: Object.fromEntries(['id', 'name', 'username', 'role', 'version'].filter(key => user[key] !== undefined).map(key => [key, user[key]])),
    jobs: (workspace.jobs ?? []).map(sanitizeMobileJob),
    incidents: (workspace.incidents ?? []).map(incident => Object.fromEntries(['id', 'jobId', 'reference', 'type', 'severity', 'description', 'status', 'createdAt', 'version'].filter(key => incident[key] !== undefined).map(key => [key, incident[key]]))),
    attachments: (workspace.attachments ?? []).map(attachment => Object.fromEntries(['id', 'jobId', 'kind', 'name', 'mimeType', 'createdAt'].filter(key => attachment[key] !== undefined).map(key => [key, attachment[key]]))),
    updatedAt: workspace.serverTime ?? new Date().toISOString(),
  };
  return structuredClone(result);
}

export function validateOperationPayload(kind, payload) {
  requireUuid(payload.jobId);
  if (kind === 'job-action') {
    if (!['start', 'deliver', 'registerPod'].includes(payload.action) || !Number.isSafeInteger(payload.version) || payload.version < 1) throw new Error('Ação ou versão do serviço inválida.');
    const result = { jobId: payload.jobId, action: payload.action, version: payload.version };
    if (payload.action !== 'start') {
      result.pod = { recipient: cleanText(payload.pod?.recipient, 'o destinatário', 120), reference: cleanText(payload.pod?.reference, 'a referência do comprovativo', 180) };
      if (payload.pod?.deliveredAt !== undefined) {
        if (typeof payload.pod.deliveredAt !== 'string' || Number.isNaN(Date.parse(payload.pod.deliveredAt))) throw new Error('Data do comprovativo inválida.');
        result.pod.deliveredAt = new Date(payload.pod.deliveredAt).toISOString();
      }
      if (payload.pod?.attachmentIds) {
        if (!Array.isArray(payload.pod.attachmentIds) || payload.pod.attachmentIds.length > 8) throw new Error('Comprovativos inválidos.');
        result.pod.attachmentIds = payload.pod.attachmentIds.map(requireUuid);
      }
    }
    return result;
  }
  if (kind === 'incident') {
    if (!Object.hasOwn(INCIDENT_TYPES, payload.type) || !Object.hasOwn(INCIDENT_SEVERITIES, payload.severity)) throw new Error('Selecione o tipo e a gravidade da ocorrência.');
    return { jobId: payload.jobId, type: payload.type, severity: payload.severity, description: cleanText(payload.description, 'a descrição da ocorrência', 2000, 10) };
  }
  if (kind === 'attachment') {
    if (!['pod-photo', 'signature', 'document', 'incident-photo'].includes(payload.kind) || !['image/jpeg', 'image/png', 'application/pdf'].includes(payload.mimeType)) throw new Error('Tipo de anexo inválido.');
    if (payload.kind !== 'document' && payload.mimeType === 'application/pdf') throw new Error('Selecione uma imagem para este comprovativo.');
    if (payload.kind === 'signature' && payload.mimeType !== 'image/png') throw new Error('A assinatura deve ser uma imagem PNG.');
    const name = cleanText(payload.name, 'o nome do ficheiro', 160);
    if (/[\u0000-\u001f\\/]/.test(name)) throw new Error('Nome de ficheiro inválido.');
    if (typeof payload.dataBase64 !== 'string' || !payload.dataBase64.length || payload.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.dataBase64)) throw new Error('Conteúdo do anexo inválido ou superior a 3 MB.');
    const size = payload.dataBase64.length * 3 / 4 - (payload.dataBase64.endsWith('==') ? 2 : payload.dataBase64.endsWith('=') ? 1 : 0);
    if (size > MAX_ATTACHMENT_BYTES) throw new Error('O anexo pode ter até 3 MB após preparação.');
    return { jobId: payload.jobId, kind: payload.kind, name, mimeType: payload.mimeType, dataBase64: payload.dataBase64 };
  }
  throw new Error('Tipo de operação inválido.');
}

// The small hash is only a lookup hint; deduplication ALSO compares the entire
// canonical payload, so a hash collision cannot discard a different operation.
export function operationFingerprint(kind, payload, dependencies = []) {
  const input = stableJson({ kind, payload, dependencies });
  let first = 2166136261, second = 5381;
  for (let index = 0; index < input.length; index++) {
    first = Math.imul(first ^ input.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ input.charCodeAt(index);
  }
  return `${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}-${input.length}`;
}

export function createOperation({ userId, kind, payload, operationId, dependencies = [], createdAt = new Date().toISOString() }) {
  requireUuid(userId); requireUuid(operationId);
  const validated = validateOperationPayload(kind, payload);
  if (!Array.isArray(dependencies) || dependencies.length > 8) throw new Error('Dependências inválidas.');
  const ids = [...new Set(dependencies.map(requireUuid))];
  return { operationId, userId, jobId: validated.jobId, kind, payload: validated, dependencies: ids, createdAt, fingerprint: operationFingerprint(kind, validated, ids), status: 'pending', attempts: 0, error: '' };
}

export function addToQueue(queue, operation, currentUserId) {
  requireUuid(currentUserId);
  if (operation.userId !== currentUserId || queue.some(item => item.userId !== currentUserId)) throw new Error('Os registos pendentes pertencem a outra conta.');
  if (queue.some(item => item.operationId === operation.operationId)) throw new Error('Identificador de operação já utilizado.');
  const existing = queue.find(item => item.status !== 'sent' && !item.reviewedByOperationId && item.fingerprint === operation.fingerprint && item.kind === operation.kind && stableJson(item.payload) === stableJson(operation.payload) && stableJson(item.dependencies) === stableJson(operation.dependencies));
  if (existing) return { queue: structuredClone(queue), operation: structuredClone(existing), duplicate: true };
  const pending = queue.filter(item => item.status !== 'sent' && !item.reviewedByOperationId);
  if (pending.length >= MAX_QUEUE_ITEMS || pending.reduce((sum, item) => sum + stableJson(item.payload).length, 0) + stableJson(operation.payload).length > MAX_QUEUE_BYTES) throw new Error('O armazenamento pendente está cheio. Envie os registos antes de guardar mais anexos.');
  return { queue: [...structuredClone(queue), structuredClone(operation)], operation: structuredClone(operation), duplicate: false };
}

export function canSendOperation(operation, currentUser, authenticated, queue = []) {
  if (!authenticated || currentUser?.id !== operation.userId) return { allowed: false, reason: 'auth' };
  if (!['pending', 'auth'].includes(operation.status)) return { allowed: false, reason: operation.status };
  for (const id of operation.dependencies ?? []) {
    const attachment = queue.find(item => item.operationId === id);
    if (!attachment || attachment.userId !== operation.userId || attachment.jobId !== operation.jobId || attachment.kind !== 'attachment' || attachment.status !== 'sent' || !UUID.test(attachment.receipt?.attachmentId ?? '')) return { allowed: false, reason: 'dependency' };
  }
  return { allowed: true };
}

export function prepareRequest(operation, queue) {
  if (operation.requestPayload) return structuredClone(operation.requestPayload);
  const payload = structuredClone(operation.payload);
  if (operation.dependencies?.length) {
    if (operation.kind !== 'job-action' || !payload.pod) throw new Error('A operação não aceita dependências.');
    payload.pod.attachmentIds = operation.dependencies.map(id => {
      const item = queue.find(entry => entry.operationId === id);
      if (!item || item.status !== 'sent' || item.userId !== operation.userId || item.jobId !== operation.jobId) throw new Error('Envie e confirme os anexos antes da entrega.');
      return requireUuid(item.receipt?.attachmentId);
    });
  }
  return { ...payload, operationId: operation.operationId };
}

export function acknowledgeOperation(operation, response) {
  if (response?.acknowledged !== true || response.operationId !== operation.operationId) throw new Error('O servidor não confirmou esta operação. O registo continua pendente.');
  const receipt = { acknowledgedAt: new Date().toISOString() };
  if (operation.kind === 'attachment') receipt.attachmentId = requireUuid(response.attachment?.id);
  if (operation.kind === 'incident' && response.incident?.id) receipt.incidentId = requireUuid(response.incident.id);
  // Uploaded base64 is removed only AFTER acknowledgment. Keep IDs to resolve
  // dependent deliveries and prevent retry after a lost response from duplicating.
  const result = { ...structuredClone(operation), status: 'sent', receipt, error: '' };
  if (result.kind === 'attachment') { delete result.payload.dataBase64; if (result.requestPayload) delete result.requestPayload.dataBase64; }
  return result;
}

export function failedOperation(operation, status, message) {
  const next = status === 401 || status === 403 ? 'auth' : status === 409 ? 'conflict' : status >= 400 && status < 500 ? 'error' : 'pending';
  return { ...structuredClone(operation), status: next, error: String(message ?? 'Ligação indisponível.').slice(0, 300) };
}

export function recoverQueue(queue, userId) {
  return queue.filter(item => item.userId === userId).map(item => ({ ...structuredClone(item), ...(item.status === 'sending' ? { status: 'pending' } : {}) }));
}

export function reviewConflict(operation, freshJob, currentUserId, newOperationId) {
  if (operation.userId !== currentUserId || operation.status !== 'conflict' || operation.kind !== 'job-action') throw new Error('Este registo exige tratamento manual nas operações.');
  if (operation.jobId !== freshJob.id || !Number.isSafeInteger(freshJob.version)) throw new Error('Atualize primeiro o serviço correto.');
  const action = operation.payload.action;
  if (action === 'start' && (freshJob.status !== 'Agendado' || !freshJob.dispatchedAt) || action === 'deliver' && freshJob.status !== 'Em curso' || action === 'registerPod' && (freshJob.status !== 'Concluído' || freshJob.pod)) throw new Error('O estado atual já não permite esta ação. Contacte operações.');
  return createOperation({ userId: currentUserId, kind: operation.kind, payload: { ...operation.payload, version: freshJob.version }, operationId: newOperationId, dependencies: operation.dependencies });
}
