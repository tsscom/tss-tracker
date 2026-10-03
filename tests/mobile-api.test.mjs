import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTrackerServer } from '../server.mjs';
import { decodeAttachment, MAX_ATTACHMENT_BYTES } from '../lib/attachments.mjs';
import { validateNetworkOptions, requestAuthority } from '../lib/network.mjs';

const PASSWORD = 'Mobile validation password 2026';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tss-mobile-api-')), file = join(dir, 'jobs.json');
  let server, base;
  async function start() { server = await createTrackerServer({ dataFile: file }); await new Promise(done => server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server?.listening) await new Promise(done => server.close(done)); }
  function client() {
    let cookie = '', csrf = '';
    return { async call(path, method = 'GET', body) {
      const reply = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', Cookie: cookie, 'X-CSRF-Token': csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (reply.headers.get('set-cookie')) cookie = reply.headers.get('set-cookie').split(';')[0];
      const data = reply.headers.get('content-type')?.includes('application/json') ? await reply.json() : await reply.arrayBuffer();
      if (data.csrfToken) csrf = data.csrfToken;
      return { status: reply.status, body: data, headers: reply.headers };
    } };
  }
  t.after(async () => { await stop(); const target = resolve(dir); assert.equal(resolve(join(target, '..')), resolve(tmpdir())); assert.ok(basename(target).startsWith('tss-mobile-api-')); await rm(target, { recursive: true, force: true }); });
  await start();
  return { dir, file, client, start, stop, storage: () => server.storage };
}
async function ok(client, path, method = 'GET', body, status = 200) { const reply = await client.call(path, method, body); assert.equal(reply.status, status, `${path}: ${JSON.stringify(reply.body)}`); return reply.body; }

test('Driver proofs, private files and retry receipts preserve assignment, versions and financial privacy', async t => {
  const f = await fixture(t), owner = f.client(), driver = f.client(), stranger = f.client(), anonymous = f.client();
  await ok(owner, '/api/setup', 'POST', { name: 'Gerente fictício', username: 'manager', password: PASSWORD }, 201);
  const account = (await ok(owner, '/api/users', 'POST', { name: 'Motorista de teste', username: 'driver', password: PASSWORD, role: 'motorista', active: true }, 201)).user;
  await ok(owner, '/api/users', 'POST', { name: 'Outro motorista', username: 'other', password: PASSWORD, role: 'motorista', active: true }, 201);
  await ok(driver, '/api/login', 'POST', { username: 'driver', password: PASSWORD });
  await ok(stranger, '/api/login', 'POST', { username: 'other', password: PASSWORD });
  const customer = (await ok(owner, '/api/customers', 'POST', { name: 'Cliente fictício' }, 201)).customer;
  let quote = (await ok(owner, '/api/quotes', 'POST', { customerId: customer.id, pickup: 'Alenquer', delivery: 'Lisboa', pickupDate: '2035-10-12', deliveryDate: '2035-10-12', quotedPrice: '500,00' }, 201)).quote;
  quote = (await ok(owner, `/api/quotes/${quote.id}/actions`, 'POST', { action: 'submit', version: quote.version })).quote;
  quote = (await ok(owner, `/api/quotes/${quote.id}/actions`, 'POST', { action: 'approve', version: quote.version, ownerOverride: true, reason: 'Validação fictícia pelo proprietário nos testes automáticos.' })).quote;
  let job = (await ok(owner, `/api/quotes/${quote.id}/actions`, 'POST', { action: 'accept', version: quote.version, acceptanceReference: 'Encomenda fictícia' })).job;
  job = (await ok(owner, `/api/jobs/${job.id}`, 'PUT', { version: job.version, pickupTime: '08:00', deliveryTime: '10:00', driverUserId: account.id, vehicle: 'TEST-MOBILE' })).job;
  job = (await ok(owner, `/api/jobs/${job.id}/actions`, 'POST', { action: 'dispatch', version: job.version })).job;
  const upload = { jobId: job.id, kind: 'signature', name: 'assinatura.png', mimeType: 'image/png', dataBase64: PNG, operationId: randomUUID() };
  assert.equal((await anonymous.call('/api/attachments', 'POST', upload)).status, 401);
  assert.equal((await stranger.call('/api/attachments', 'POST', upload)).status, 403);
  const uploaded = await ok(driver, '/api/attachments', 'POST', upload, 201);
  assert.equal(uploaded.acknowledged, true);
  assert.ok(!('storageKey' in uploaded.attachment));
  assert.equal((await ok(driver, '/api/attachments', 'POST', upload, 201)).attachment.id, uploaded.attachment.id);
  assert.equal((await ok(driver, '/api/attachments', 'POST', { ...upload, operationId: upload.operationId.toUpperCase() }, 201)).attachment.id, uploaded.attachment.id);
  assert.equal((await driver.call('/api/attachments', 'POST', { ...upload, name: 'alterada.png' })).status, 409);
  assert.equal((await anonymous.call(uploaded.attachment.url)).status, 401);
  assert.equal((await stranger.call(uploaded.attachment.url)).status, 403);
  const download = await driver.call(uploaded.attachment.url);
  assert.equal(download.status, 200); assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(download.body), Buffer.from(PNG, 'base64'));
  assert.equal((await anonymous.call('/data/attachments/' + uploaded.attachment.sha256 + '.bin')).status, 404);
  const mobile = await ok(driver, '/api/mobile/workspace');
  assert.equal(mobile.jobs.length, 1); assert.deepEqual(mobile.jobs[0].allowedActions, ['start']);
  for (const key of ['priceCents', 'quotedPrice', 'paymentStatus', 'quoteId', 'automation', 'cancelRequest']) assert.ok(!(key in mobile.jobs[0]));
  assert.ok(!('mobileOperations' in mobile)); assert.ok(!('storageKey' in mobile.attachments[0]));
  const start = { action: 'start', version: job.version, operationId: randomUUID() };
  const starts = await Promise.all([driver.call(`/api/jobs/${job.id}/actions`, 'POST', start), driver.call(`/api/jobs/${job.id}/actions`, 'POST', start)]);
  assert.deepEqual(starts.map(reply => reply.status), [200, 200]);
  assert.equal(starts[0].body.job.version, starts[1].body.job.version);
  job = starts[0].body.job;
  assert.ok(!('priceCents' in job));
  const deliver = { action: 'deliver', version: job.version, pod: { recipient: 'Destinatário fictício', reference: 'POD-TESTE', attachmentIds: [uploaded.attachment.id] }, operationId: randomUUID() };
  assert.equal((await driver.call(`/api/jobs/${job.id}/actions`, 'POST', { ...deliver, version: 0 })).status, 409);
  const delivery = await ok(driver, `/api/jobs/${job.id}/actions`, 'POST', deliver);
  assert.equal(delivery.job.status, 'Concluído'); assert.deepEqual(delivery.job.pod.attachmentIds, [uploaded.attachment.id]);
  assert.ok(!('invoice' in delivery));
  const state = await f.storage().read();
  assert.equal(state.attachments.length, 1); assert.equal(state.invoices.filter(row => row.jobId === job.id).length, 1);
  assert.equal(state.audit.filter(row => row.event === 'job.deliver' && row.entityId === job.id).length, 1);
  assert.equal(state.mobileOperations.length, 3);
  // An assignment changed after acceptance must not make an old receipt disclose data.
  await f.storage().mutate(next => { next.jobs.find(row => row.id === job.id).driverUserId = null; });
  assert.equal((await driver.call(`/api/jobs/${job.id}/actions`, 'POST', deliver)).status, 403);
  await f.storage().mutate(next => { next.jobs.find(row => row.id === job.id).driverUserId = account.id; });
  await f.stop(); await f.start();
  await ok(driver, '/api/login', 'POST', { username: 'driver', password: PASSWORD });
  await ok(stranger, '/api/login', 'POST', { username: 'other', password: PASSWORD });
  assert.equal((await ok(driver, `/api/jobs/${job.id}/actions`, 'POST', deliver)).acknowledged, true);
  const restored = await f.storage().read(); assert.equal(restored.invoices.filter(row => row.jobId === job.id).length, 1);
  const incidentPayload = { jobId: job.id, type: 'damage', severity: 'low', description: 'Embalagem com pequena marca.', operationId: randomUUID() };
  const incident = await ok(driver, '/api/incidents', 'POST', incidentPayload, 201);
  assert.equal((await ok(driver, '/api/incidents', 'POST', incidentPayload, 201)).incident.id, incident.incident.id);
  assert.equal((await stranger.call('/api/incidents', 'POST', incidentPayload)).status, 403);
  assert.equal((await ok(stranger, '/api/mobile/workspace')).jobs.length, 0);
  const metadata = restored.attachments[0], blob = join(f.dir, 'attachments', metadata.storageKey);
  await writeFile(blob, 'corrupt'); assert.equal((await driver.call(uploaded.attachment.url)).status, 503);
  // PWA assets are public; API and proof responses are always uncached.
  const manifest = await anonymous.call('/manifest.webmanifest'); assert.equal(manifest.status, 200);
  const worker = await anonymous.call('/sw.js'); assert.equal(worker.status, 200); assert.equal(worker.headers.get('service-worker-allowed'), '/');
});

test('Proof upload rejects paths, unsupported payloads and oversized files; network access needs explicit TLS', () => {
  const valid = { name: 'pod.png', mimeType: 'image/png', kind: 'pod-photo', dataBase64: PNG };
  assert.equal(decodeAttachment(valid).bytes.length, Buffer.from(PNG, 'base64').length);
  for (const input of [{ ...valid, name: '../outside.png' }, { ...valid, dataBase64: '%%%=' }, { ...valid, mimeType: 'text/html' }, { ...valid, dataBase64: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64') }, { ...valid, mimeType: 'image/jpeg', kind: 'signature' }]) assert.throws(() => decodeAttachment(input));
  assert.throws(() => validateNetworkOptions({ allowedHosts: ['192.168.1.50:4317'] }), /TLS/);
  assert.throws(() => validateNetworkOptions({ allowedHosts: ['https://bad.test:4317'], tls: {} }), /ALLOWED_HOSTS/);
  const options = validateNetworkOptions({ allowedHosts: ['tss.test:4317'], tls: {} });
  assert.equal(requestAuthority({ socket: { encrypted: true }, headers: { host: 'tss.test:4317' } }, 4317, options).secure, true);
  assert.throws(() => requestAuthority({ socket: {}, headers: { host: 'tss.test:4317' } }, 4317, options));
  assert.throws(() => requestAuthority({ socket: { encrypted: true }, headers: { host: 'evil.test:4317' } }, 4317, options));
});
