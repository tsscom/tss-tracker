import http from 'node:http';
import https from 'node:https';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { filterJobs, toCsv } from './public/domain.mjs';
import { createStorageRepository } from './lib/repository.mjs';
import { fail, token, text, username, hashPassword, verifyPassword, publicUser, requirePermission, permissionsFor } from './lib/security.mjs';
import { audit, workspace, scopedJobs, dispatchReadiness, createJob, saveJob, jobAction, saveCustomer, customerAction, createQuote, saveQuote, quoteAction, yardAction, createWorkOrder, saveWorkOrder, workOrderAction, createInvoice, saveInvoice, invoiceAction, saveUser } from './lib/business.mjs';
import { workflowView, updateWorkflowConfiguration } from './lib/workflows.mjs';
import { saveVehicle, saveDriver, saveOpportunity, opportunityAction, saveActivity, saveCost, saveIncident, incidentAction } from './lib/operations.mjs';
import { applyMobileOperation } from './lib/mobile-operations.mjs';
import { authorizeJobDocument, saveAttachment, readAttachment, validatePodAttachments } from './lib/attachments.mjs';
import { validateNetworkOptions, requestAuthority } from './lib/network.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/domain.mjs', ['domain.mjs', 'text/javascript; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/motorista', ['mobile.html', 'text/html; charset=utf-8']], ['/motorista/', ['mobile.html', 'text/html; charset=utf-8']],
  ['/mobile.html', ['mobile.html', 'text/html; charset=utf-8']],
  ['/mobile.mjs', ['mobile.mjs', 'text/javascript; charset=utf-8']], ['/mobile-model.mjs', ['mobile-model.mjs', 'text/javascript; charset=utf-8']],
  ['/mobile.css', ['mobile.css', 'text/css; charset=utf-8']], ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']], ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/icon-maskable-512.png', ['icons/icon-maskable-512.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['icons/apple-touch-icon.png', 'image/png']],
]);
function send(response, status, data) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); }
async function readBody(request, limit = 65_536) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > limit) fail(413, 'O pedido é demasiado grande.'); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'O pedido contém dados inválidos.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'O pedido deve conter um objeto JSON.');
  return value;
}
function cookies(request) {
  const values = {};
  for (const part of (request.headers.cookie ?? '').split(';')) { const index = part.indexOf('='); if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1).trim(); }
  return values;
}
function setCookie(response, value, secure, clear = false) { response.setHeader('Set-Cookie', `tss_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 8 * 60 * 60}${secure ? '; Secure' : ''}`); }
const MOBILE_JOB_FIELDS = ['id', 'reference', 'customer', 'pickup', 'delivery', 'pickupDate', 'deliveryDate', 'pickupTime', 'deliveryTime', 'vehicle', 'driver', 'driverUserId', 'status', 'version', 'dispatchedAt', 'pod', 'cargo', 'weightKg', 'pallets', 'instructions', 'dispatchReadiness'];
function mobileJob(store, user, job) {
  const safe = Object.fromEntries(MOBILE_JOB_FIELDS.filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  safe.cancellationPending = store.jobs.find(record => record.id === job.id)?.cancelRequest?.status === 'Em aprovação';
  safe.allowedActions = permissionsFor(user).includes('jobs.execute') && !safe.cancellationPending ? [
    ...(job.status === 'Agendado' && job.dispatchedAt && job.dispatchReadiness?.ready ? ['start'] : []),
    ...(job.status === 'Em curso' ? ['deliver'] : []),
    ...(job.status === 'Concluído' && !job.pod ? ['registerPod'] : []),
  ] : [];
  return safe;
}
export async function createTrackerServer({ dataFile = join(ROOT, 'data', 'jobs.json'), storageBackend = 'json', databaseUrl, repository, attachmentsDir = join(dirname(dataFile), 'attachments'), network = {}, sessionAbsoluteMs = 8 * 60 * 60 * 1000, sessionIdleMs = 30 * 60 * 1000, loginWindowMs = 15 * 60 * 1000, loginMaxAttempts = 5 } = {}) {
  const networkOptions = validateNetworkOptions(network);
  const storage = repository ?? await createStorageRepository({ backend: storageBackend, dataFile, connectionString: databaseUrl });
  try { await storage.read(); } catch (error) { await storage.close(); throw error; }
  const sessions = new Map(), failures = new Map(), dummyCredential = await hashPassword(token());
  const mutate = change => storage.mutate(change);
  function userIn(next, session) { const user = next.users.find(value => value.id === session?.userId); if (!user?.active || user.securityVersion !== session.securityVersion || Date.now() > session.expiresAt || Date.now() - session.lastSeenAt > sessionIdleMs) fail(401, 'A sessão terminou. Inicie sessão novamente.'); return user; }
  function sessionOf(request, store) {
    const key = cookies(request).tss_session, session = sessions.get(key), instant = Date.now();
    if (!session) return null;
    if (instant > session.expiresAt || instant - session.lastSeenAt > sessionIdleMs) { sessions.delete(key); return null; }
    const user = store.users.find(value => value.id === session.userId);
    if (!user?.active || user.securityVersion !== session.securityVersion) { sessions.delete(key); return null; }
    session.lastSeenAt = instant; return session;
  }
  function openSession(user, response, secure) {
    const instant = Date.now(), key = token();
    for (const [id, session] of sessions) if (instant > session.expiresAt || instant - session.lastSeenAt > sessionIdleMs) sessions.delete(id);
    const session = { userId: user.id, securityVersion: user.securityVersion, csrfToken: token(), expiresAt: instant + sessionAbsoluteMs, lastSeenAt: instant };
    sessions.set(key, session); setCookie(response, key, secure);
    return { setupRequired: false, user: publicUser(user), csrfToken: session.csrfToken, permissions: permissionsFor(user) };
  }
  function throttle(key, limit) { const entry = failures.get(key); if (entry && Date.now() - entry.startedAt < loginWindowMs && entry.count >= limit) fail(429, 'Demasiadas tentativas. Aguarde 15 minutos antes de tentar novamente.'); }
  function registerFailure(key) {
    const old = failures.get(key), entry = old && Date.now() - old.startedAt < loginWindowMs ? old : { count: 0, startedAt: Date.now() };
    entry.count++; failures.set(key, entry);
    for (const [id, value] of failures) if (Date.now() - value.startedAt >= loginWindowMs) failures.delete(id);
  }
  async function documentList() {
    let entries; try { entries = await readdir(join(ROOT, 'documentacao'), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && /\.(docx|pdf|md)$/i.test(entry.name)).map(entry => ({ name: entry.name, title: entry.name.replace(/\.(docx|pdf|md)$/i, '').replaceAll('-', ' ').replaceAll('_', ' '), url: `/api/documents/${encodeURIComponent(entry.name)}` }));
  }
  const handler = async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      // Render probes its private address, before the public Host/HTTPS checks.
      if (request.method === 'GET' && request.url?.split('?')[0] === '/healthz') {
        try { await storage.read(); return send(response, 200, { status: 'ok' }); }
        catch { return send(response, 503, { status: 'unavailable' }); }
      }
      const { secure, origin } = requestAuthority(request, server.address()?.port, networkOptions);
      const url = new URL(request.url, origin), path = url.pathname, api = path.startsWith('/api/'), writing = api && !['GET', 'HEAD'].includes(request.method);
      if (writing) {
        if (request.headers['x-tss-request'] !== '1' || (request.headers.origin && request.headers.origin !== origin)) fail(403, 'Pedido não autorizado.');
        if (['POST', 'PUT'].includes(request.method) && !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) fail(415, 'Envie os dados em formato JSON.');
      }
      const store = api ? await storage.read() : null;
      const session = api ? sessionOf(request, store) : null;
      if (path === '/api/session' && request.method === 'GET') return send(response, 200, { setupRequired: !store.users.length, user: session ? publicUser(userIn(store, session)) : null, ...(session ? { csrfToken: session.csrfToken, permissions: permissionsFor(userIn(store, session)) } : {}) });
      if (path === '/api/setup' && request.method === 'POST') {
        const input = await readBody(request), user = await mutate(async next => {
          if (next.users.length) fail(409, 'A configuração inicial já foi concluída. Inicie sessão.');
          const at = new Date().toISOString(), user = { id: randomUUID(), name: text(input.name, 'nome', 120), username: username(input.username), password: await hashPassword(input.password), role: 'gerente', active: true, securityVersion: 1, createdAt: at, updatedAt: at, version: 1 };
          next.users.push(user); audit(next, user, 'security.setup', 'user', user.id); return user;
        });
        return send(response, 201, openSession(user, response, secure));
      }
      if (path === '/api/login' && request.method === 'POST') {
        const input = await readBody(request), login = typeof input.username === 'string' ? input.username.trim().toLowerCase().slice(0, 60) : '', key = `${request.socket.remoteAddress}:${login}`, ipKey = `ip:${request.socket.remoteAddress}`;
        throttle(key, loginMaxAttempts); throttle(ipKey, loginMaxAttempts * 4);
        registerFailure(key); registerFailure(ipKey);
        const user = store.users.find(value => value.username === login), securityVersion = user?.securityVersion, verified = await verifyPassword(input.password, user?.password ?? dummyCredential), current = (await storage.read()).users.find(value => value.id === user?.id);
        if (!verified || !current?.active || current.securityVersion !== securityVersion) { await mutate(next => audit(next, null, 'security.loginFailed', 'user', null, { username: login })); fail(401, 'Utilizador ou palavra-passe inválidos.'); }
        failures.delete(key); failures.delete(ipKey);
        const authenticated = await mutate(next => { const actor = next.users.find(value => value.id === current.id); if (!actor?.active || actor.securityVersion !== securityVersion) fail(401, 'A conta foi alterada. Tente novamente.'); audit(next, actor, 'security.login', 'user', actor.id); return actor; });
        const previous = cookies(request).tss_session; if (previous) sessions.delete(previous);
        return send(response, 200, openSession(authenticated, response, secure));
      }
      if (api) {
        if (!session) fail(401, 'Inicie sessão para continuar.');
        const user = userIn(store, session);
        if (writing && request.headers['x-csrf-token'] !== session.csrfToken) fail(403, 'Token de segurança inválido. Atualize a página.');
        if (path === '/api/logout' && request.method === 'POST') { await mutate(next => { const actor = userIn(next, session); audit(next, actor, 'security.logout', 'user', actor.id); }); sessions.delete(cookies(request).tss_session); setCookie(response, '', secure, true); return send(response, 200, { ok: true }); }
        if (path === '/api/password' && request.method === 'POST') {
          const input = await readBody(request); if (!await verifyPassword(input.currentPassword, user.password)) fail(400, 'A palavra-passe atual é inválida.');
          const changed = await mutate(async next => { const actor = userIn(next, session); actor.password = await hashPassword(input.newPassword); actor.securityVersion++; actor.version++; actor.updatedAt = new Date().toISOString(); audit(next, actor, 'security.passwordChanged', 'user', actor.id); return actor; });
          for (const [key, value] of sessions) if (value.userId === user.id) sessions.delete(key);
          return send(response, 200, openSession(changed, response, secure));
        }
        if (path === '/api/workspace' && request.method === 'GET') return send(response, 200, workspace(store, user));
        if (path === '/api/mobile/workspace' && request.method === 'GET') {
          requirePermission(user, 'jobs.read');
          const visible = workspace(store, user);
          const jobs = visible.jobs.map(job => mobileJob(store, user, job));
          return send(response, 200, { user: publicUser(user), csrfToken: session.csrfToken, permissions: permissionsFor(user), jobs, incidents: visible.incidents ?? [], attachments: visible.attachments ?? [], serverTime: new Date().toISOString(), network: { secure, localOnly: !networkOptions.trustProxy && networkOptions.allowedHosts.length === 0 } });
        }
        if (path === '/api/attachments' && request.method === 'POST') {
          const input = await readBody(request, 4_300_000);
          const result = await mutate(next => {
            const actor = userIn(next, session);
            authorizeJobDocument(next, actor, input.jobId, true);
            return applyMobileOperation(next, actor, input, 'attachments:create', () => saveAttachment(next, actor, input, attachmentsDir, audit));
          });
          return send(response, 201, result);
        }
        const attachmentMatch = path.match(/^\/api\/attachments\/([0-9a-f-]{36})$/);
        if (attachmentMatch && request.method === 'GET') {
          const { record, bytes } = await readAttachment(store, user, attachmentMatch[1], attachmentsDir);
          response.writeHead(200, { 'Content-Type': record.mimeType, 'Content-Length': bytes.length, 'Content-Disposition': `${record.mimeType === 'application/pdf' ? 'attachment' : 'inline'}; filename="documento.${record.mimeType === 'image/png' ? 'png' : record.mimeType === 'image/jpeg' ? 'jpg' : 'pdf'}"; filename*=UTF-8''${encodeURIComponent(record.name)}` });
          return response.end(bytes);
        }
        if (path === '/api/workflows' && request.method === 'GET') return send(response, 200, workflowView(store, user));
        if (path === '/api/workflows' && request.method === 'PUT') {
          const input = await readBody(request);
          return send(response, 200, await mutate(next => updateWorkflowConfiguration(next, userIn(next, session), input, audit)));
        }
        if (path === '/api/jobs' && request.method === 'GET') return send(response, 200, { jobs: scopedJobs(store, user) });
        if (path === '/api/documents' && request.method === 'GET') return send(response, 200, { documents: await documentList() });
        if (path.startsWith('/api/documents/') && request.method === 'GET') {
          let name; try { name = decodeURIComponent(path.slice('/api/documents/'.length)); } catch { fail(400, 'Nome do documento inválido.'); }
          if (/[\\/\u0000]/.test(name) || !(await documentList()).some(item => item.name === name)) fail(404, 'Documento não encontrado.');
          const content = await readFile(join(ROOT, 'documentacao', name));
          const extension = name.split('.').at(-1).toLowerCase();
          response.writeHead(200, { 'Content-Type': extension === 'pdf' ? 'application/pdf' : extension === 'md' ? 'text/markdown; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="documento.${extension}"; filename*=UTF-8''${encodeURIComponent(name)}` }); return response.end(content);
        }
        if (path === '/api/export.csv' && request.method === 'GET') { requirePermission(user, 'export'); const exported = filterJobs(scopedJobs(store, user), Object.fromEntries(url.searchParams)); response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="tss-servicos-${new Date().toISOString().slice(0, 10)}.csv"` }); return response.end(toCsv(exported)); }
        const collectionRoutes = new Map([['/api/customers', saveCustomer], ['/api/quotes', createQuote], ['/api/jobs', createJob], ['/api/yard', yardAction], ['/api/work-orders', createWorkOrder], ['/api/invoices', createInvoice], ['/api/users', saveUser], ['/api/vehicles', saveVehicle], ['/api/drivers', saveDriver], ['/api/opportunities', saveOpportunity], ['/api/activities', saveActivity], ['/api/costs', saveCost], ['/api/incidents', saveIncident]]);
        if (collectionRoutes.has(path) && request.method === 'POST') {
          const input = await readBody(request), operation = collectionRoutes.get(path);
          const result = await mutate(next => {
            const actor = userIn(next, session);
            if (path === '/api/incidents') {
              requirePermission(actor, 'incidents.write');
              const job = next.jobs.find(item => item.id === input.jobId);
              if (!job) fail(404, 'O serviço não existe.');
              if (actor.role === 'motorista' && job.driverUserId !== actor.id) fail(403, 'Só pode registar incidências dos seus serviços.');
              return applyMobileOperation(next, actor, input, 'incidents:create', () => operation(next, actor, input));
            }
            return operation(next, actor, input);
          });
          return send(response, 201, result);
        }
        const match = path.match(/^\/api\/(jobs|customers|quotes|work-orders|invoices|users|vehicles|drivers|opportunities|activities|costs|incidents)\/([0-9a-f-]{36})(\/actions)?$/);
        if (match && ((match[3] && request.method === 'POST') || (!match[3] && request.method === 'PUT'))) {
          const actionRoutes = { jobs: jobAction, customers: customerAction, quotes: quoteAction, 'work-orders': workOrderAction, invoices: invoiceAction, opportunities: opportunityAction, incidents: incidentAction }, updateRoutes = { jobs: saveJob, customers: (next, actor, id, input) => saveCustomer(next, actor, input, id), quotes: saveQuote, 'work-orders': saveWorkOrder, invoices: saveInvoice, users: (next, actor, id, input) => saveUser(next, actor, input, id), ...Object.fromEntries([['vehicles', saveVehicle], ['drivers', saveDriver], ['opportunities', saveOpportunity], ['activities', saveActivity], ['costs', saveCost], ['incidents', saveIncident]].map(([key, save]) => [key, (next, actor, id, input) => save(next, actor, input, id)])) }, operation = (match[3] ? actionRoutes : updateRoutes)[match[1]];
          if (!operation) fail(405, 'Esta operação não é suportada.');
          const input = await readBody(request), result = await mutate(async next => {
            const actor = userIn(next, session);
            if (match[1] === 'jobs' && match[3]) {
              requirePermission(actor, input.action === 'dispatch' ? 'jobs.plan' : ['cancel', 'approveCancel', 'rejectCancel'].includes(input.action) ? 'jobs.cancel' : 'jobs.execute');
              const job = next.jobs.find(item => item.id === match[2]);
              if (!job) fail(404, 'O serviço não existe.');
              if (actor.role === 'motorista' && job.driverUserId !== actor.id) fail(403, 'Só pode executar serviços atribuídos a si.');
              validatePodAttachments(next, actor, job.id, input);
              const result = await applyMobileOperation(next, actor, input, `jobs:${job.id}:actions`, () => {
                const result = operation(next, actor, job.id, input);
                return input.operationId ? { job: mobileJob(next, actor, result.job) } : result;
              });
              if (input.operationId) result.job = mobileJob(next, actor, { ...job, dispatchReadiness: dispatchReadiness(next, job) });
              return result;
            }
            return operation(next, actor, match[2], input);
          }); return send(response, 200, result);
        }
        if (match && request.method === 'DELETE') fail(405, 'Os registos operacionais são preservados. Use o procedimento de cancelamento.');
      }
      const asset = ASSETS.get(path);
      if (asset && ['GET', 'HEAD'].includes(request.method)) { const content = await readFile(join(ROOT, 'public', asset[0])); if (path === '/sw.js') response.setHeader('Service-Worker-Allowed', '/'); response.writeHead(200, { 'Content-Type': asset[1] }); return response.end(request.method === 'HEAD' ? undefined : content); }
      return send(response, 404, { error: 'Página não encontrada.' });
    } catch (error) { if (!error.status) console.error(error); if (!response.headersSent) send(response, error.status ?? 500, { error: error.status ? error.message : 'Não foi possível gravar ou carregar os dados. Tente novamente.' }); else response.end(); }
  };
  const server = networkOptions.tls ? https.createServer(networkOptions.tls, handler) : http.createServer(handler);
  server.storage = storage;
  server.on('close', () => { sessions.clear(); storage.close().catch(() => console.error('Não foi possível terminar a ligação ao armazenamento.')); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { loadLocalEnv } = await import('./tools/postgres-env.mjs');
    if (process.env.ENV_FILE !== '') await loadLocalEnv(resolve(ROOT, process.env.ENV_FILE ?? '.env'));
    if (![undefined, '', '0', '1'].includes(process.env.TRUST_PROXY)) throw new Error('TRUST_PROXY deve ser 0 ou 1.');
    const trustProxy = process.env.TRUST_PROXY === '1';
    const port = Number(process.env.PORT ?? 4317), host = process.env.HOST ?? (trustProxy ? '0.0.0.0' : '127.0.0.1'), storageBackend = process.env.STORAGE_BACKEND ?? 'json';
    const dataDir = resolve(ROOT, process.env.DATA_DIR ?? 'data'), dataFile = join(dataDir, 'jobs.json'), attachmentsDir = resolve(ROOT, process.env.ATTACHMENTS_DIR ?? join(dataDir, 'attachments'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve ser uma porta entre 1 e 65535.');
    const keyPath = process.env.TLS_KEY_FILE, certPath = process.env.TLS_CERT_FILE;
    if (!!keyPath !== !!certPath) throw new Error('Configure TLS_KEY_FILE e TLS_CERT_FILE em conjunto.');
    const tls = keyPath ? { key: await readFile(resolve(ROOT, keyPath)), cert: await readFile(resolve(ROOT, certPath)) } : undefined;
    const allowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean);
    const network = validateNetworkOptions({ allowedHosts, tls, publicOrigin: process.env.PUBLIC_ORIGIN, trustProxy });
    if (!network.trustProxy && !['127.0.0.1', 'localhost', '::1'].includes(host) && (!tls || !allowedHosts.length)) throw new Error('O teste em telemóveis exige HTTPS e ALLOWED_HOSTS explícito. Consulte o guia Mobile e operações.');
    const server = await createTrackerServer({ dataFile, storageBackend, databaseUrl: process.env.DATABASE_URL, attachmentsDir, network });
    server.on('error', error => { console.error(`Não foi possível iniciar a aplicação: ${error.message}`); process.exitCode = 1; });
    server.listen(port, host, () => { console.log(`TSS Transportes: ${network.publicOrigin ?? `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`}`); console.log(server.storage.kind === 'json' ? `Dados guardados em: ${dataFile}` : 'Dados guardados em: PostgreSQL (schema tss).'); if (allowedHosts.length) console.log(`Endereços HTTPS autorizados: ${allowedHosts.join(', ')}`); console.log('Configure o gerente no primeiro acesso. Mantenha esta janela aberta; Ctrl+C para terminar.'); });
    const stop = () => server.close(async () => { await server.storage.close(); process.exit(0); });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
