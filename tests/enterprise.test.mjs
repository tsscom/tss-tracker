import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTrackerServer } from '../server.mjs';
import { normalizeJob } from '../public/domain.mjs';

const PASSWORD = 'A long unique test passphrase 2026';
const OVERRIDE = { ownerOverride: true, reason: 'Validação local autorizada pelo proprietário único.' };
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tss-enterprise-test-')), file = join(dir, 'jobs.json');
  let server, base;
  async function start() { server = await createTrackerServer({ dataFile: file, ...options }); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); base = `http://127.0.0.1:${server.address().port}`; }
  async function stop() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { await stop(); for (const name of await readdir(dir)) await unlink(join(dir, name)); await rmdir(dir); });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, extraHeaders = {}) {
        const match = path.match(/^\/api\/(jobs|customers|quotes|work-orders|invoices|users)\/([^/]+)(?:\/actions)?$/);
        if (body && body.version === undefined && match && ['POST', 'PUT', 'DELETE'].includes(method)) {
          const snapshot = await this.call('/api/workspace');
          const collection = match[1] === 'work-orders' ? 'workOrders' : match[1];
          const item = snapshot.body[collection]?.find(value => value.id === match[2]);
          body = { ...body, version: item?.version ?? 1 };
          if (match[1] === 'invoices' && body.action === 'approve' && body.workflowVersion === undefined) body.workflowVersion = snapshot.body.workflowPolicy?.version;
        }
        if (path === '/api/yard' && method === 'POST' && ['move', 'checkout'].includes(body?.action) && body.version === undefined) {
          const snapshot = await this.call('/api/workspace'), item = snapshot.body.yard?.find(value => value.vehicle === body.vehicle && !value.checkedOutAt);
          body = { ...body, version: item?.version ?? 1 };
        }
        const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extraHeaders }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const type = response.headers.get('content-type') ?? '', result = /application\/json/.test(type) ? await response.json() : await response.text();
        if (result.csrfToken) csrf = result.csrfToken;
        // Preserve coverage of the manual workflow, independently of the enabled-by-default rules.
        if (path === '/api/setup' && response.status === 201) {
          const settings = await this.call('/api/workflows');
          assert.equal(settings.status, 200, JSON.stringify(settings.body));
          const changed = await this.call('/api/workflows', 'PUT', {
            version: settings.body.configuration.version,
            rules: { quoteAcceptedToJob: false, deliveryToInvoiceDraft: false, invoiceApprovedToIssued: false },
            invoiceDueDays: 30, reason: 'Cobertura dos procedimentos manuais nos testes de regressão.',
          });
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
        }
        return { status: response.status, body: result, headers: response.headers };
      },
      async login(username, password = PASSWORD) { const result = await this.call('/api/login', 'POST', { username, password }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.user; },
    };
  }
  return { file, dir, start, stop, client };
}
async function ok(client, path, method, input, expected = 200) { const result = await client.call(path, method, input); assert.equal(result.status, expected, `${path}: ${JSON.stringify(result.body)}`); return result.body; }
async function user(owner, role, name = role) { return (await ok(owner, '/api/users', 'POST', { name, username: name.toLowerCase(), password: PASSWORD, role, active: true }, 201)).user; }
async function quote(client, customerId, changes = {}) { return (await ok(client, '/api/quotes', 'POST', { customerId, pickup: 'Alenquer', delivery: 'Porto', pickupDate: '2026-10-12', deliveryDate: '2026-10-13', quotedPrice: '1000,00', ...changes }, 201)).quote; }
const action = (client, type, id, name, fields = {}) => ok(client, `/api/${type}/${id}/actions`, 'POST', { action: name, ...fields });
async function jobFromQuote(owner, customerId, changes = {}) {
  const quotation = await quote(owner, customerId, changes);
  await action(owner, 'quotes', quotation.id, 'submit'); await action(owner, 'quotes', quotation.id, 'approve', OVERRIDE); await action(owner, 'quotes', quotation.id, 'accept', { acceptanceReference: 'Email do cliente 12/10' });
  return (await action(owner, 'quotes', quotation.id, 'convert', { vehicle: changes.vehicle ?? 'TEST-01', driver: changes.driver ?? 'Motorista responsável', driverUserId: changes.driverUserId })).job;
}

test('Migration preserves exact v1 backup, records and reported payment history', async t => {
  const f = await fixture(t);
  const oldJob = { id: randomUUID(), reference: 'TSS-0042', ...normalizeJob({ customer: 'Cliente real', pickup: 'Alenquer', delivery: 'Évora', pickupDate: '2026-09-10', deliveryDate: '2026-09-10', driver: 'Sergiu', vehicle: 'AB-12-CD', quotedPrice: '350,00', status: 'Concluído', paymentStatus: 'Pago' }), sample: false, createdAt: '2026-09-10T12:00:00.000Z', updatedAt: '2026-09-10T12:00:00.000Z' };
  const original = JSON.stringify({ schemaVersion: 1, nextNumber: 43, jobs: [oldJob] }, null, 2) + '\n'; await writeFile(f.file, original);
  await f.start(); const store = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(store.schemaVersion, 2); assert.equal(store.jobs.length, 1); assert.equal(store.jobs[0].id, oldJob.id); assert.equal(store.jobs[0].priceCents, 35000); assert.equal(store.jobs[0].status, 'Concluído'); assert.equal(store.jobs[0].legacyPaymentStatus, 'Pago'); assert.equal(store.jobs[0].paymentStatus, 'Pendente'); assert.equal(store.jobs[0].pod, null); assert.equal(store.invoices.length, 0); assert.equal(store.users.length, 0);
  assert.equal(await readFile(store.migration.backupFile, 'utf8'), original);
  await f.stop(); await f.start(); assert.equal((await readdir(f.dir)).filter(name => name.includes('v1-backup')).length, 1);
});

test('First owner setup, CSRF, RBAC, approvals, dispatch, delivery and payment operate end to end', async t => {
  const f = await fixture(t); await f.start(); const owner = f.client(), anonymous = f.client();
  assert.equal((await anonymous.call('/api/jobs')).status, 401);
  assert.equal((await owner.call('/api/session')).body.setupRequired, true);
  assert.equal((await owner.call('/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: 'short' })).status, 400);
  const setup = await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201);
  assert.equal(setup.user.role, 'gerente'); assert.ok(!('password' in setup.user));
  assert.equal((await anonymous.call('/api/setup', 'POST', { name: 'Outra pessoa', username: 'other', password: PASSWORD })).status, 409);
  assert.equal((await owner.call('/api/customers', 'POST', { name: 'Externo' }, { Origin: 'https://external.example' })).status, 403);
  assert.equal((await owner.call('/api/customers', 'POST', { name: 'Sem CSRF' }, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await owner.call('/api/users/' + setup.user.id, 'PUT', { active: false })).status, 409);
  const identities = {};
  for (const role of ['administrador', 'comercial', 'operacoes', 'motorista', 'parque', 'oficina', 'financeiro', 'auditor']) identities[role] = await user(owner, role);
  const people = {};
  for (const role of Object.keys(identities)) { people[role] = f.client(); await people[role].login(role); }
  const customer = (await ok(people.comercial, '/api/customers', 'POST', { name: 'Cliente Empresa', taxId: 'PT123456789', email: 'cliente@example.test' }, 201)).customer;
  assert.equal(customer.creditLimitCents, 0);
  assert.equal((await people.auditor.call('/api/customers', 'POST', { name: 'Não permitido' })).status, 403);
  assert.equal((await people.administrador.call('/api/users/' + setup.user.id, 'PUT', { password: 'Impersonation attempted password' })).status, 403);
  assert.equal((await people.administrador.call('/api/users', 'POST', { name: 'Elevado', username: 'elevado', role: 'gerente', password: PASSWORD })).status, 403);
  const adminData = await ok(people.administrador, '/api/workspace'); assert.equal(adminData.jobs.length, 0); assert.equal(adminData.customers.length, 0); assert.equal(adminData.invoices.length, 0); assert.ok(adminData.users.length > 0);
  await action(people.comercial, 'customers', customer.id, 'requestCredit', { creditLimit: '5000', reason: 'Condições comerciais aprováveis.' });
  assert.equal((await people.comercial.call(`/api/customers/${customer.id}`, 'PUT', { taxId: 'PT999999999' })).status, 409);
  await action(owner, 'customers', customer.id, 'approveCredit');
  assert.equal((await people.comercial.call(`/api/customers/${customer.id}`, 'PUT', { creditLimit: '100000' })).status, 409);
  const q = await quote(people.comercial, customer.id);
  await action(people.comercial, 'quotes', q.id, 'submit');
  assert.equal((await people.comercial.call(`/api/quotes/${q.id}`, 'PUT', { quotedPrice: '1' })).status, 409);
  assert.equal((await people.administrador.call(`/api/quotes/${q.id}/actions`, 'POST', { action: 'approve', ...OVERRIDE })).status, 403);
  await action(owner, 'quotes', q.id, 'approve');
  assert.equal((await people.comercial.call(`/api/quotes/${q.id}/actions`, 'POST', { action: 'accept' })).status, 400);
  await action(people.comercial, 'quotes', q.id, 'accept', { acceptanceReference: 'Email aceite 12 outubro' });
  const job = (await action(people.operacoes, 'quotes', q.id, 'convert', { driverUserId: identities.motorista.id, vehicle: 'AB-12-CD' })).job;
  assert.equal(job.priceCents, 100000);
  assert.equal((await people.operacoes.call('/api/jobs', 'POST', { ...job, quotedPrice: '1' })).status, 409);
  assert.equal((await people.operacoes.call(`/api/jobs/${job.id}`, 'PUT', { quotedPrice: '1' })).status, 409);
  assert.equal((await people.operacoes.call(`/api/jobs/${job.id}`, 'PUT', { status: 'Concluído' })).status, 409);
  assert.equal((await people.operacoes.call(`/api/jobs/${job.id}`, 'DELETE')).status, 405);
  await ok(people.operacoes, `/api/jobs/${job.id}`, 'PUT', { driverUserId: identities.motorista.id, vehicle: 'AB-12-CD', pickupDate: '2026-10-14', deliveryDate: '2026-10-15' });
  assert.equal((await people.motorista.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'start' })).status, 409);
  const driverData = await ok(people.motorista, '/api/workspace'); assert.equal(driverData.jobs.length, 1); assert.ok(!('priceCents' in driverData.jobs[0])); assert.ok(!('paymentStatus' in driverData.jobs[0])); assert.equal(driverData.customers.length, 0); assert.equal(driverData.quotes.length, 0); assert.equal(driverData.invoices.length, 0);
  assert.equal((await people.motorista.call('/api/export.csv')).status, 403);
  const unassigned = (await ok(owner, '/api/jobs')).jobs.find(value => value.id !== job.id); assert.equal((await people.motorista.call(`/api/jobs/${unassigned.id}/actions`, 'POST', { action: 'registerPod', pod: { recipient: 'Outra pessoa', reference: 'POD-999' } })).status, 403);
  await action(people.operacoes, 'jobs', job.id, 'dispatch');
  await action(people.motorista, 'jobs', job.id, 'start');
  assert.equal((await people.financeiro.call('/api/invoices', 'POST', { jobId: job.id, dueDate: '2026-10-30' })).status, 409);
  assert.equal((await people.motorista.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'deliver' })).status, 400);
  await action(people.motorista, 'jobs', job.id, 'deliver', { pod: { recipient: 'Responsável do cliente', reference: 'CMR-123' } });
  const invoice = (await ok(people.financeiro, '/api/invoices', 'POST', { jobId: job.id, dueDate: '2026-10-30' }, 201)).invoice;
  assert.match(invoice.documentType, /não é fatura fiscal/); assert.equal(invoice.amountCents, 100000);
  assert.equal((await people.financeiro.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'issue' })).status, 409);
  await action(people.financeiro, 'invoices', invoice.id, 'submit');
  assert.equal((await people.financeiro.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'approve', ...OVERRIDE })).status, 403);
  await action(owner, 'invoices', invoice.id, 'approve'); await action(people.financeiro, 'invoices', invoice.id, 'issue');
  assert.equal((await people.financeiro.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'pay', amount: '-1', paymentReference: 'BANK-1' })).status, 400);
  assert.equal((await people.financeiro.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'pay', amount: '1000,01', paymentReference: 'BANK-1' })).status, 409);
  const partial = await action(people.financeiro, 'invoices', invoice.id, 'pay', { amount: '300', paymentReference: 'BANK-1' }); assert.equal(partial.job.paymentStatus, 'Parcial');
  const partialCsv = await owner.call('/api/export.csv?paymentStatus=Parcial'); assert.equal(partialCsv.status, 200); assert.ok(partialCsv.body.includes(job.reference));
  assert.equal((await people.financeiro.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'pay', amount: '100', paymentReference: 'BANK-1' })).status, 409);
  const paid = await action(people.financeiro, 'invoices', invoice.id, 'pay', { amount: '700', paymentReference: 'BANK-2' }); assert.equal(paid.invoice.status, 'Paga'); assert.equal(paid.job.paymentStatus, 'Pago');
  const csv = await owner.call('/api/export.csv?search=Cliente%20Empresa&status=Conclu%C3%ADdo'); assert.equal(csv.status, 200); assert.match(csv.body, /1000,00/);
  const file = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(file.users[0].password.algorithm, 'scrypt'); assert.equal(file.users[0].password.N, 131072); assert.ok(!JSON.stringify(file).includes(PASSWORD));
  const auditEvents = (await ok(owner, '/api/workspace')).audit; assert.ok(auditEvents.some(event => event.event === 'invoice.pay')); assert.ok(auditEvents.every(event => event.id && event.at));
  const adminAudit = (await ok(people.administrador, '/api/workspace')).audit; assert.ok(adminAudit.every(event => /^(security\.|user\.|migration\.)/.test(event.event))); assert.ok(!adminAudit.some(event => event.event === 'invoice.pay'));
  const beforeRestart = await owner.call('/api/jobs'); await f.stop(); await f.start(); assert.equal((await owner.call('/api/jobs')).status, 401); await owner.login('sergiu'); const restored = await ok(owner, '/api/jobs'); assert.equal(restored.jobs.length, beforeRestart.body.jobs.length); assert.equal(restored.jobs.find(value => value.id === job.id).paymentStatus, 'Pago');
});

test('Owner override is explicit, justified, and audited across approval workflows', async t => {
  const f = await fixture(t); await f.start(); const owner = f.client(); await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201);
  const customer = (await ok(owner, '/api/customers', 'POST', { name: 'Cliente de validação' }, 201)).customer;
  await action(owner, 'customers', customer.id, 'requestCredit', { creditLimit: '1000', reason: 'Pedido no piloto local.' });
  assert.equal((await owner.call(`/api/customers/${customer.id}/actions`, 'POST', { action: 'approveCredit' })).status, 409);
  await action(owner, 'customers', customer.id, 'approveCredit', OVERRIDE);
  const q = await quote(owner, customer.id); await action(owner, 'quotes', q.id, 'submit');
  assert.equal((await owner.call(`/api/quotes/${q.id}/actions`, 'POST', { action: 'approve' })).status, 409);
  assert.equal((await owner.call(`/api/quotes/${q.id}/actions`, 'POST', { action: 'approve', ownerOverride: true, reason: 'Curta' })).status, 400);
  await action(owner, 'quotes', q.id, 'approve', OVERRIDE); await action(owner, 'quotes', q.id, 'accept', { acceptanceReference: 'Aceite por email' });
  const job = (await action(owner, 'quotes', q.id, 'convert', { driver: 'Sergiu Sandu', vehicle: 'OWNER-1' })).job;
  await action(owner, 'jobs', job.id, 'cancel', { reason: 'Cliente pediu para cancelar.' }); assert.equal((await owner.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'approveCancel' })).status, 409); await action(owner, 'jobs', job.id, 'approveCancel', OVERRIDE);
  const another = await jobFromQuote(owner, customer.id, { vehicle: 'OWNER-2' }); await action(owner, 'jobs', another.id, 'dispatch'); await action(owner, 'jobs', another.id, 'start'); await action(owner, 'jobs', another.id, 'deliver', { pod: { recipient: 'Cliente', reference: 'POD-OWNER' } });
  const invoice = (await ok(owner, '/api/invoices', 'POST', { jobId: another.id, dueDate: '2026-10-30' }, 201)).invoice; await action(owner, 'invoices', invoice.id, 'submit'); assert.equal((await owner.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'approve' })).status, 409); await action(owner, 'invoices', invoice.id, 'approve', OVERRIDE);
  const work = (await ok(owner, '/api/work-orders', 'POST', { vehicle: 'OWNER-WORK', description: 'Inspeção no piloto', estimatedCost: '50' }, 201)).workOrder;
  await action(owner, 'work-orders', work.id, 'submit'); assert.equal((await owner.call(`/api/work-orders/${work.id}/actions`, 'POST', { action: 'approve' })).status, 409); await action(owner, 'work-orders', work.id, 'approve', OVERRIDE); await action(owner, 'work-orders', work.id, 'start'); await action(owner, 'work-orders', work.id, 'complete', { actualCost: '50', reason: 'Inspeção e verificação concluídas pelo proprietário.' });
  assert.equal((await owner.call(`/api/work-orders/${work.id}/actions`, 'POST', { action: 'release' })).status, 409); const release = await action(owner, 'work-orders', work.id, 'release', OVERRIDE); assert.equal(release.workOrder.releaseApproval.ownerOverride, true); assert.ok(release.workOrder.completionNotes);
  const overrides = (await ok(owner, '/api/workspace')).audit.filter(event => event.details.ownerOverride); assert.ok(overrides.length >= 4); assert.ok(overrides.every(event => event.actorRole === 'gerente' && event.details.reason.length >= 20));
});

test('Yard occupancy, workshop blocks and dispatch rechecks prevent unsafe release', async t => {
  const f = await fixture(t); await f.start(); const owner = f.client(); await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201);
  const mechanicUser = await user(owner, 'oficina'), gateUser = await user(owner, 'parque'), driverUser = await user(owner, 'motorista');
  const mechanic = f.client(), gate = f.client(); await mechanic.login(mechanicUser.username); await gate.login(gateUser.username);
  const customer = (await ok(owner, '/api/customers', 'POST', { name: 'Cliente de frota' }, 201)).customer;
  const job = await jobFromQuote(owner, customer.id, { vehicle: 'YARD-1', driverUserId: driverUser.id }); const second = await jobFromQuote(owner, customer.id, { vehicle: 'YARD-2' });
  await ok(gate, '/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, location: 'A1', action: 'checkin' }, 201);
  assert.equal((await gate.call('/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, location: 'A2', action: 'checkin' })).status, 409);
  assert.equal((await gate.call('/api/yard', 'POST', { jobId: second.id, vehicle: second.vehicle, location: 'a1', action: 'checkin' })).status, 409);
  await ok(gate, '/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, location: 'A2', action: 'move' }, 201);
  assert.equal((await owner.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'dispatch' })).status, 409);
  const work = (await ok(mechanic, '/api/work-orders', 'POST', { vehicle: job.vehicle, description: 'Rever travões', estimatedCost: '300' }, 201)).workOrder;
  assert.equal((await gate.call('/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, action: 'checkout' })).status, 409);
  await action(mechanic, 'work-orders', work.id, 'submit'); await action(owner, 'work-orders', work.id, 'approve');
  assert.equal((await mechanic.call(`/api/work-orders/${work.id}`, 'PUT', { estimatedCost: '1' })).status, 409);
  await action(mechanic, 'work-orders', work.id, 'start'); await action(mechanic, 'work-orders', work.id, 'complete', { actualCost: '350', reason: 'Travões revistos e inspeção concluída.' });
  assert.equal((await mechanic.call(`/api/work-orders/${work.id}/actions`, 'POST', { action: 'release' })).status, 403);
  assert.equal((await owner.call(`/api/work-orders/${work.id}/actions`, 'POST', { action: 'release' })).status, 400);
  await action(owner, 'work-orders', work.id, 'release', { reason: 'Aprovo o custo final de peças adicionais e a inspeção.' });
  await ok(gate, '/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, action: 'checkout' }, 201);
  await action(owner, 'jobs', job.id, 'dispatch');
  // Re-entry after authorization must still block the later start transition.
  await ok(gate, '/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, location: 'A3', action: 'checkin' }, 201);
  assert.equal((await owner.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'start' })).status, 409); await ok(gate, '/api/yard', 'POST', { jobId: job.id, vehicle: job.vehicle, action: 'checkout' }, 201);
  await ok(owner, `/api/users/${driverUser.id}`, 'PUT', { active: false }); assert.equal((await owner.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'start' })).status, 400);
  await ok(owner, `/api/users/${driverUser.id}`, 'PUT', { active: true }); await action(owner, 'jobs', job.id, 'start');
  const overlap = await jobFromQuote(owner, customer.id, { vehicle: job.vehicle }); assert.equal((await owner.call(`/api/jobs/${overlap.id}/actions`, 'POST', { action: 'dispatch' })).status, 409);
  const parkData = await ok(gate, '/api/workspace'); assert.ok(!('priceCents' in parkData.jobs[0])); assert.ok(!('estimatedCostCents' in parkData.workOrders[0])); assert.equal(parkData.invoices.length, 0);
});

test('Session invalidation, password rotation, logout and concurrent login throttling', async t => {
  const f = await fixture(t, { loginMaxAttempts: 2 }); await f.start(); const owner = f.client(); const setup = await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201);
  const financeUser = await user(owner, 'financeiro'), finance = f.client(); await finance.login(financeUser.username);
  await ok(owner, `/api/users/${financeUser.id}`, 'PUT', { active: false }); assert.equal((await finance.call('/api/workspace')).status, 401);
  assert.equal((await finance.call('/api/login', 'POST', { username: financeUser.username, password: PASSWORD })).status, 401);
  await ok(owner, `/api/users/${financeUser.id}`, 'PUT', { active: true }); await finance.login(financeUser.username); await ok(owner, `/api/users/${financeUser.id}`, 'PUT', { role: 'auditor' }); assert.equal((await finance.call('/api/workspace')).status, 401);
  const secondSession = f.client(); await secondSession.login('sergiu');
  assert.equal((await owner.call('/api/password', 'POST', { currentPassword: 'wrong', newPassword: 'Another very long passphrase' })).status, 400);
  await ok(owner, '/api/password', 'POST', { currentPassword: PASSWORD, newPassword: 'Another very long passphrase' }); assert.equal((await secondSession.call('/api/workspace')).status, 401); assert.equal((await owner.call('/api/workspace')).status, 200);
  const logout = await ok(owner, '/api/logout', 'POST', {}); assert.equal(logout.ok, true); assert.equal((await owner.call('/api/workspace')).status, 401);
  const attacker = f.client(); const attempts = await Promise.all(Array.from({ length: 4 }, () => attacker.call('/api/login', 'POST', { username: 'unknown-account', password: PASSWORD }))); assert.equal(attempts.filter(value => value.status === 401).length, 2); assert.equal(attempts.filter(value => value.status === 429).length, 2);
  assert.equal((await attacker.call('/api/login', 'POST', { username: 'unknown-account', password: PASSWORD })).status, 429);
  assert.equal(setup.user.role, 'gerente');
});

test('Expired sessions cannot read or write and authenticated docs block traversal', async t => {
  const f = await fixture(t, { sessionAbsoluteMs: 60, sessionIdleMs: 60 }); await f.start(); const owner = f.client();
  const response = await owner.call('/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }); assert.equal(response.status, 201); assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  const docs = await owner.call('/api/documents'); assert.equal(docs.status, 200);
  const traversal = await owner.call('/api/documents/..%5Cdata%5Cjobs.json'); assert.equal(traversal.status, 404);
  await new Promise(resolve => setTimeout(resolve, 90)); assert.equal((await owner.call('/api/jobs')).status, 401); assert.equal((await owner.call('/api/customers', 'POST', { name: 'Depois da expiração' })).status, 401);
});

test('Serialized concurrent writes preserve unique references and reject stale versions', async t => {
  const f = await fixture(t); await f.start(); const owner = f.client(); await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201);
  const customer = (await ok(owner, '/api/customers', 'POST', { name: 'Cliente concorrente' }, 201)).customer;
  const quotes = await Promise.all(Array.from({ length: 8 }, (_, i) => quote(owner, customer.id, { quotedPrice: String(100 + i) })));
  assert.equal(new Set(quotes.map(value => value.reference)).size, 8);
  const first = quotes[0]; assert.equal((await owner.call(`/api/quotes/${first.id}/actions`, 'POST', { action: 'submit', version: null })).status, 409); await ok(owner, `/api/quotes/${first.id}`, 'PUT', { quotedPrice: '999', version: first.version }); assert.equal((await owner.call(`/api/quotes/${first.id}`, 'PUT', { quotedPrice: '1', version: first.version })).status, 409);
  const stored = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(stored.quotes.length, 8); assert.equal(stored.quotes.find(value => value.id === first.id).priceCents, 99900);
});
