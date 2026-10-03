import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MAX_ATTACHMENT_BYTES, sanitizeMobileSnapshot, createOperation, operationFingerprint, addToQueue, canSendOperation, prepareRequest, acknowledgeOperation, failedOperation, recoverQueue, reviewConflict } from '../public/mobile-model.mjs';

const USER = randomUUID(), OTHER_USER = randomUUID(), JOB = randomUUID();
const delivery = () => ({ jobId: JOB, action: 'deliver', version: 7, pod: { recipient: 'Destinatário fictício', reference: 'POD-FICTÍCIO-001', deliveredAt: '2026-10-02T10:30:00Z' } });
const operation = (kind = 'job-action', payload = delivery(), extra = {}) => createOperation({ userId: USER, kind, payload, operationId: randomUUID(), ...extra });
const image = () => ({ jobId: JOB, kind: 'pod-photo', name: 'comprovativo.jpg', mimeType: 'image/jpeg', dataBase64: Buffer.from('Fictional fixture bytes').toString('base64') });

test('Offline snapshots retain operational fields and discard prices, passwords, tokens and private storage keys', () => {
  const result = sanitizeMobileSnapshot({
    user: { id: USER, name: 'Motorista fictício', username: 'mobile.fixture', role: 'motorista', password: { hash: 'secret' }, creditLimitCents: 100 },
    csrfToken: 'secret-token', invoices: [{ amountCents: 999 }],
    jobs: [{ id: JOB, version: 7, customer: 'Cliente', status: 'Em curso', priceCents: 999, quotedPrice: '9,99', paymentStatus: 'Pago', legacyPaymentStatus: 'Pago', quoteId: 'private', cargo: 'Paletes', weightKg: 1200, instructions: 'Portão 2', allowedActions: ['deliver', 'dispatch'], pod: { recipient: 'Nome', reference: 'POD', deliveredAt: '2026-10-02', privateField: 'secret' } }],
    attachments: [{ id: randomUUID(), jobId: JOB, name: 'POD.jpg', kind: 'pod-photo', storageKey: 'private/server/path', dataBase64: 'secret' }],
    incidents: [{ id: randomUUID(), jobId: JOB, description: 'Descrição', status: 'Aberta', internalCostCents: 100 }],
  });
  assert.equal(result.jobs[0].cargo, 'Paletes'); assert.equal(result.jobs[0].weightKg, 1200); assert.equal(result.jobs[0].instructions, 'Portão 2');
  assert.deepEqual(result.jobs[0].allowedActions, ['deliver']);
  for (const secret of ['secret', 'priceCents', 'paymentStatus', 'creditLimitCents', 'storageKey', 'dataBase64', 'invoices', 'privateField', 'internalCostCents']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('Offline delivery validation requires a recipient, reference and original positive version', () => {
  for (const invalid of [{ ...delivery(), pod: { recipient: '', reference: 'POD' } }, { ...delivery(), pod: { recipient: 'Nome', reference: '' } }, { ...delivery(), pod: { recipient: 'x'.repeat(121), reference: 'POD' } }, { ...delivery(), version: 0 }, { ...delivery(), version: '7' }, { ...delivery(), action: 'dispatch' }, { ...delivery(), pod: { ...delivery().pod, deliveredAt: 'invalid-date' } }]) assert.throws(() => operation('job-action', invalid));
  const queued = operation(); assert.equal(queued.payload.version, 7); assert.equal(queued.payload.pod.deliveredAt, '2026-10-02T10:30:00.000Z');
});

test('Attachment validation bounds size and mime types before any offline capture is accepted', () => {
  assert.throws(() => operation('attachment', { ...image(), dataBase64: '?' }));
  assert.throws(() => operation('attachment', { ...image(), mimeType: 'text/html' }));
  assert.throws(() => operation('attachment', { ...image(), mimeType: 'application/pdf' }));
  assert.throws(() => operation('attachment', { ...image(), kind: 'signature' }));
  assert.throws(() => operation('attachment', { ...image(), name: '../comprovativo.jpg' }));
  assert.throws(() => operation('attachment', { ...image(), dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }));
  assert.equal(operation('attachment', image()).payload.kind, 'pod-photo');
});

test('Incident validation accepts agreed enum keys and excludes arbitrary additional fields', () => {
  const queued = operation('incident', { jobId: JOB, type: 'delay', severity: 'medium', description: 'Atraso fictício na descarga.', priceCents: 100 });
  assert.equal(queued.payload.type, 'delay'); assert.equal(queued.payload.priceCents, undefined);
  assert.throws(() => operation('incident', { jobId: JOB, type: 'Atraso', severity: 'medium', description: 'Descrição fictícia.' }));
  assert.throws(() => operation('incident', { jobId: JOB, type: 'delay', severity: 'low', description: '123456789' }));
  assert.equal(operation('incident', { jobId: JOB, type: 'delay', severity: 'low', description: '1234567890' }).payload.description.length, 10);
});

test('Fingerprints ignore object key order while repeated taps preserve the first stable operation ID', () => {
  const first = operation();
  assert.equal(operationFingerprint('job-action', delivery()), operationFingerprint('job-action', { pod: { reference: 'POD-FICTÍCIO-001', deliveredAt: '2026-10-02T10:30:00Z', recipient: 'Destinatário fictício' }, version: 7, action: 'deliver', jobId: JOB }));
  const initial = addToQueue([], first, USER); const repeated = addToQueue(initial.queue, operation(), USER);
  assert.equal(repeated.duplicate, true); assert.equal(repeated.operation.operationId, first.operationId); assert.equal(repeated.queue.length, 1);
  assert.throws(() => addToQueue(initial.queue, first, USER), /já utilizado/);
});

test('A fingerprint collision cannot discard a different payload and queues cannot cross identities', () => {
  const first = operation(), second = operation('job-action', { ...delivery(), pod: { ...delivery().pod, reference: 'POD-DIFERENTE' } }); second.fingerprint = first.fingerprint;
  const added = addToQueue([first], second, USER); assert.equal(added.queue.length, 2);
  assert.throws(() => addToQueue([], first, OTHER_USER), /outra conta/);
  assert.throws(() => addToQueue([first], operation(undefined, undefined, { userId: OTHER_USER }), OTHER_USER), /outra conta/);
  assert.equal(canSendOperation(first, { id: OTHER_USER }, true).allowed, false);
  assert.equal(canSendOperation(first, { id: USER }, false).allowed, false);
  assert.equal(canSendOperation(first, { id: USER }, true).allowed, true);
});

test('Delivery cannot send before all same-user same-job attachments are acknowledged', () => {
  const photo = operation('attachment', image()); const queued = operation('job-action', delivery(), { dependencies: [photo.operationId] });
  assert.equal(canSendOperation(queued, { id: USER }, true, [photo, queued]).reason, 'dependency');
  assert.throws(() => prepareRequest(queued, [photo, queued]), /antes da entrega/);
  const attachmentId = randomUUID(); const acknowledged = acknowledgeOperation(photo, { acknowledged: true, operationId: photo.operationId, attachment: { id: attachmentId } });
  const readyQueue = [acknowledged, queued]; assert.equal(canSendOperation(queued, { id: USER }, true, readyQueue).allowed, true);
  const request = prepareRequest(queued, readyQueue); assert.deepEqual(request.pod.attachmentIds, [attachmentId]); assert.equal(request.version, 7); assert.equal(request.operationId, queued.operationId);
  assert.equal(canSendOperation(queued, { id: USER }, true, [{ ...acknowledged, userId: OTHER_USER }, queued]).allowed, false);
});

test('A persisted resolved request remains identical for retry and does not absorb a newer job version', () => {
  const queued = operation(); const payload = prepareRequest(queued, []); const sending = { ...queued, requestPayload: payload, status: 'sending' };
  const recovered = recoverQueue([sending], USER)[0]; assert.equal(recovered.status, 'pending');
  const retry = prepareRequest(recovered, []); assert.deepEqual(retry, payload); assert.equal(retry.version, 7);
  assert.equal(recoverQueue([sending], OTHER_USER).length, 0);
});

test('Only matching server acknowledgement completes an operation and releases local image bytes', () => {
  const photo = operation('attachment', image()); const original = structuredClone(photo);
  assert.throws(() => acknowledgeOperation(photo, { acknowledged: false, operationId: photo.operationId }));
  assert.throws(() => acknowledgeOperation(photo, { acknowledged: true, operationId: randomUUID(), attachment: { id: randomUUID() } }));
  const sent = acknowledgeOperation(photo, { acknowledged: true, operationId: photo.operationId, attachment: { id: randomUUID() } });
  assert.equal(sent.status, 'sent'); assert.equal(sent.payload.dataBase64, undefined); assert.deepEqual(photo, original);
  assert.equal(canSendOperation(sent, { id: USER }, true).allowed, false);
});

test('Network, authentication and version conflicts retain the captured record without silently rewriting its version', () => {
  const queued = operation();
  for (const [status, expected] of [[0, 'pending'], [500, 'pending'], [401, 'auth'], [403, 'auth'], [409, 'conflict'], [400, 'error']]) {
    const failed = failedOperation(queued, status, 'Falha fictícia'); assert.equal(failed.status, expected); assert.deepEqual(failed.payload, queued.payload); assert.equal(failed.operationId, queued.operationId);
  }
  const failed = failedOperation(queued, 409, 'Versão alterada'); assert.equal(canSendOperation(failed, { id: USER }, true).allowed, false);
});

test('Manual conflict review creates a separate operation after validating the fresh state and account', () => {
  const conflict = failedOperation(operation(), 409, 'Versão alterada'); const nextId = randomUUID();
  const fresh = { id: JOB, version: 9, status: 'Em curso' };
  const reviewed = reviewConflict(conflict, fresh, USER, nextId);
  assert.equal(reviewed.payload.version, 9); assert.equal(reviewed.operationId, nextId); assert.equal(conflict.payload.version, 7); assert.equal(conflict.status, 'conflict');
  assert.throws(() => reviewConflict(conflict, fresh, OTHER_USER, randomUUID()));
  assert.throws(() => reviewConflict(conflict, { ...fresh, status: 'Concluído' }, USER, randomUUID()));
  assert.throws(() => reviewConflict({ ...conflict, status: 'pending' }, fresh, USER, randomUUID()));
});

test('A start review cannot authorize its own departure', () => {
  const conflict = failedOperation(operation('job-action', { jobId: JOB, version: 2, action: 'start' }), 409, 'Saída não autorizada');
  assert.throws(() => reviewConflict(conflict, { id: JOB, version: 3, status: 'Agendado' }, USER, randomUUID()));
  assert.equal(reviewConflict(conflict, { id: JOB, version: 3, status: 'Agendado', dispatchedAt: '2026-10-02T08:00:00Z' }, USER, randomUUID()).payload.version, 3);
});

test('The service worker only intercepts public app shell assets, never API, attachment, login or management responses', async () => {
  const listeners = new Map(), writes = [], installed = [];
  const cache = { addAll: async urls => installed.push(...urls), put: async request => writes.push(request.url) };
  const response = { ok: true, type: 'basic', clone() { return this; } };
  const origin = 'https://tss.example.test';
  const self = { location: { origin }, clients: { claim: async () => {} }, addEventListener: (event, callback) => listeners.set(event, callback) };
  runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, Response, caches: { open: async () => cache, match: async () => response, keys: async () => [], delete: async () => true }, fetch: async () => response });
  let installation; listeners.get('install')({ waitUntil: promise => { installation = promise; } }); await installation;
  assert.ok(installed.includes('/motorista')); assert.ok(installed.every(url => !url.startsWith('/api/')));
  for (const path of ['/api/mobile/workspace', '/api/jobs', '/api/session', '/api/login', '/api/logout', '/api/attachments/' + randomUUID(), '/', '/mobile.mjs?private=1']) {
    let intercepted = false;
    listeners.get('fetch')({ request: { url: origin + path, method: 'GET', mode: 'cors' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, path);
  }
  let pending; listeners.get('fetch')({ request: { url: origin + '/mobile.mjs', method: 'GET', mode: 'cors' }, respondWith: promise => { pending = promise; } });
  assert.equal(await pending, response); assert.deepEqual(writes, [origin + '/mobile.mjs']);
});
