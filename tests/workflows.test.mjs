import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, unlink, rmdir, rename, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackerServer } from '../server.mjs';

const PASSWORD = 'Workflow testing unique passphrase 2026';
const OVERRIDE = { ownerOverride: true, reason: 'Validação autorizada pelo proprietário no piloto local.' };
const RULES = { quoteAcceptedToJob: true, deliveryToInvoiceDraft: true, invoiceApprovedToIssued: true };
const OFF = Object.fromEntries(Object.keys(RULES).map(key => [key, false]));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tss-workflows-test-')), file = join(dir, 'jobs.json');
  let server, base;
  async function start() {
    server = await createTrackerServer({ dataFile: file });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
  t.after(async () => { await stop(); for (const name of await readdir(dir)) await unlink(join(dir, name)); await rmdir(dir); });
  function client() {
    let cookie = '', csrf = '';
    return {
      async call(path, method = 'GET', body, extraHeaders = {}) {
        const match = path.match(/^\/api\/(jobs|customers|quotes|work-orders|invoices|users)\/([^/]+)(?:\/actions)?$/);
        if (body && body.version === undefined && match && ['POST', 'PUT'].includes(method)) {
          const snapshot = await this.call('/api/workspace'), collection = match[1] === 'work-orders' ? 'workOrders' : match[1];
          body = { ...body, version: snapshot.body[collection]?.find(value => value.id === match[2])?.version ?? 1 };
          if (match[1] === 'invoices' && body.action === 'approve' && body.workflowVersion === undefined) body.workflowVersion = snapshot.body.workflowPolicy?.version;
        }
        const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
        const result = await response.json(); if (result.csrfToken) csrf = result.csrfToken;
        return { status: response.status, body: result };
      },
      async login(username) { return ok(this, '/api/login', 'POST', { username, password: PASSWORD }); },
    };
  }
  return { dir, file, start, stop, client };
}
async function ok(client, path, method = 'GET', input, expected = 200) {
  const response = await client.call(path, method, input);
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(response.body)}`);
  return response.body;
}
async function setup(f) { await f.start(); const owner = f.client(); await ok(owner, '/api/setup', 'POST', { name: 'Sergiu Sandu', username: 'sergiu', password: PASSWORD }, 201); return owner; }
async function person(f, owner, role) {
  const user = (await ok(owner, '/api/users', 'POST', { name: `Pessoa ${role}`, username: role, role, password: PASSWORD, active: true }, 201)).user;
  const client = f.client(); await client.login(user.username); return { user, client };
}
async function customer(owner, name = 'Cliente de automações') { return (await ok(owner, '/api/customers', 'POST', { name }, 201)).customer; }
async function quote(client, customerId, input = {}) {
  return (await ok(client, '/api/quotes', 'POST', { customerId, pickup: 'Alenquer', delivery: 'Lisboa', pickupDate: '2026-03-28', deliveryDate: '2026-03-30', quotedPrice: '1000,00', ...input }, 201)).quote;
}
const action = (client, type, id, name, input = {}) => ok(client, `/api/${type}/${id}/actions`, 'POST', { action: name, ...input });
async function approvedQuote(owner, customerId, writer = owner, input = {}) {
  const value = await quote(writer, customerId, input); await action(writer, 'quotes', value.id, 'submit');
  return (await action(owner, 'quotes', value.id, 'approve', writer === owner ? OVERRIDE : {})).quote;
}
async function settings(owner, rules, invoiceDueDays = 30) {
  const current = await ok(owner, '/api/workflows');
  return ok(owner, '/api/workflows', 'PUT', { version: current.configuration.version, rules, invoiceDueDays, reason: 'Alteração explícita das regras para validar este cenário.' });
}
async function acceptedJob(owner, customerId, fields = {}) {
  const value = await approvedQuote(owner, customerId);
  return (await action(owner, 'quotes', value.id, 'accept', { acceptanceReference: 'Aceite documentado pelo cliente', driver: 'Sergiu Sandu', vehicle: `AUTO-${value.reference}`, ...fields })).job;
}
async function deliveredJob(owner, customerId, deliveredAt = '2026-03-28T23:30:00.000Z') {
  const job = await acceptedJob(owner, customerId); await action(owner, 'jobs', job.id, 'dispatch'); await action(owner, 'jobs', job.id, 'start');
  const result = await action(owner, 'jobs', job.id, 'deliver', { pod: { recipient: 'Cliente', reference: `POD-${job.reference}`, deliveredAt } });
  return result.job;
}

test('Workflow configuration is guarded, versioned, future-only and persistent', async t => {
  const f = await fixture(t), owner = await setup(f), anonymous = f.client();
  assert.equal((await anonymous.call('/api/workflows')).status, 401);
  const initial = await ok(owner, '/api/workflows');
  assert.deepEqual(initial.configuration.rules, RULES); assert.equal(initial.configuration.invoiceDueDays, 30); assert.equal(initial.configuration.version, 1); assert.equal(initial.editable, true); assert.equal(initial.catalog.length, 3);
  const auditor = await person(f, owner, 'auditor'), commercial = await person(f, owner, 'comercial');
  const readOnly = await ok(auditor.client, '/api/workflows'); assert.equal(readOnly.editable, false);
  assert.equal((await commercial.client.call('/api/workflows')).status, 403);
  const input = { version: initial.configuration.version, rules: OFF, invoiceDueDays: 45, reason: 'Validação das regras sem efeitos retroativos.' };
  assert.equal((await auditor.client.call('/api/workflows', 'PUT', input)).status, 403);
  assert.equal((await owner.call('/api/workflows', 'PUT', input, { 'X-CSRF-Token': '' })).status, 403);
  for (const change of [{ version: null }, { rules: { ...RULES, deliveryToInvoiceDraft: 'true' } }, { rules: { quoteAcceptedToJob: false } }, { invoiceDueDays: 0 }, { invoiceDueDays: 366 }, { invoiceDueDays: 1.5 }, { reason: 'Curta' }]) {
    const result = await owner.call('/api/workflows', 'PUT', { ...input, ...change }); assert.ok([400, 409].includes(result.status), JSON.stringify(result));
  }
  const changed = await ok(owner, '/api/workflows', 'PUT', input); assert.equal(changed.configuration.version, 2); assert.deepEqual(changed.configuration.rules, OFF); assert.equal(changed.configuration.invoiceDueDays, 45);
  assert.equal((await owner.call('/api/workflows', 'PUT', input)).status, 409);
  const beforeRestart = await ok(owner, '/api/workspace'); assert.equal(beforeRestart.invoices.length, 0, 'Enabling rules must not invent invoices for legacy completed services.');
  const updateAudit = beforeRestart.audit.find(value => value.event === 'workflow.settings.update'); assert.ok(updateAudit); assert.equal(updateAudit.actorRole, 'gerente');
  await f.stop(); await f.start(); assert.equal((await owner.call('/api/workflows')).status, 401); await owner.login('sergiu');
  const restored = await ok(owner, '/api/workflows'); assert.deepEqual(restored.configuration, changed.configuration);
  const temporaryManager = await person(f, owner, 'gerente'); await ok(owner, `/api/users/${temporaryManager.user.id}`, 'PUT', { role: 'auditor' });
  assert.equal((await temporaryManager.client.call('/api/workflows', 'PUT', { ...input, version: restored.configuration.version })).status, 401, 'A stale manager session cannot update workflow rules after a role change.');
});

test('Approved acceptance automatically schedules exactly one job without bypassing dispatch or assignment', async t => {
  const f = await fixture(t), owner = await setup(f), c = await customer(owner), commercial = await person(f, owner, 'comercial');
  const value = await quote(commercial.client, c.id);
  assert.equal((await commercial.client.call(`/api/quotes/${value.id}/actions`, 'POST', { action: 'accept', acceptanceReference: 'Email do cliente' })).status, 409);
  await action(commercial.client, 'quotes', value.id, 'submit');
  let snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.quotes.find(item => item.id === value.id).status, 'Em aprovação'); assert.ok(!snapshot.jobs.some(item => item.quoteId === value.id));
  await action(owner, 'quotes', value.id, 'approve');
  assert.equal((await commercial.client.call(`/api/quotes/${value.id}/actions`, 'POST', { action: 'accept', acceptanceReference: 'x' })).status, 400);
  const approvedVersion = (await ok(commercial.client, '/api/workspace')).quotes.find(item => item.id === value.id).version;
  const inputs = { action: 'accept', acceptanceReference: 'Cliente confirmou por email', version: approvedVersion };
  const duplicates = await Promise.all([commercial.client.call(`/api/quotes/${value.id}/actions`, 'POST', inputs), commercial.client.call(`/api/quotes/${value.id}/actions`, 'POST', inputs)]);
  assert.deepEqual(duplicates.map(item => item.status).sort(), [200, 409]);
  const accepted = duplicates.find(item => item.status === 200).body; assert.equal(accepted.quote.status, 'Convertida'); assert.equal(accepted.job.status, 'Agendado'); assert.equal(accepted.quote.jobId, accepted.job.id); assert.equal(accepted.job.driver, ''); assert.equal(accepted.job.vehicle, ''); assert.ok(!accepted.job.dispatchedAt);
  assert.equal((await owner.call(`/api/quotes/${value.id}/actions`, 'POST', { action: 'convert', driver: 'Sergiu Sandu', vehicle: 'DUPLICATE' })).status, 409);
  assert.equal((await owner.call(`/api/jobs/${accepted.job.id}/actions`, 'POST', { action: 'start' })).status, 409);
  assert.equal((await owner.call(`/api/jobs/${accepted.job.id}/actions`, 'POST', { action: 'dispatch' })).status, 400);
  await ok(owner, `/api/jobs/${accepted.job.id}`, 'PUT', { driver: 'Sergiu Sandu', vehicle: 'AUTO-001' }); await action(owner, 'jobs', accepted.job.id, 'dispatch');
  snapshot = await ok(owner, '/api/workspace'); const job = snapshot.jobs.find(item => item.id === accepted.job.id); assert.equal(job.status, 'Agendado', 'Dispatch permission alone must not simulate physical departure.'); assert.equal(snapshot.jobs.filter(item => item.quoteId === value.id).length, 1);
  const transitions = snapshot.audit.filter(item => item.event === 'workflow.transition' && item.details.ruleId === 'quoteAcceptedToJob'); assert.equal(transitions.length, 2); assert.deepEqual(transitions.map(item => item.entityType).sort(), ['job', 'quote']); assert.ok(transitions.every(item => item.details.initiatorId === commercial.user.id && item.details.configVersion === 1));
  const work = (await ok(owner, '/api/work-orders', 'POST', { vehicle: 'AUTO-BLOCKED', description: 'Verificação de segurança', estimatedCost: '50' }, 201)).workOrder;
  await action(owner, 'work-orders', work.id, 'submit'); await action(owner, 'customers', c.id, 'requestCredit', { creditLimit: '2000', reason: 'Revisão de crédito pelo gerente.' }); await action(owner, 'jobs', job.id, 'cancel', { reason: 'Pedido de cancelamento do cliente.' });
  snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.workOrders.find(item => item.id === work.id).status, 'Em aprovação'); assert.equal(snapshot.customers.find(item => item.id === c.id).creditLimitCents, 0); assert.equal(snapshot.customers.find(item => item.id === c.id).creditRequest.status, 'Em aprovação'); assert.equal(snapshot.jobs.find(item => item.id === job.id).status, 'Agendado'); assert.equal(snapshot.jobs.find(item => item.id === job.id).cancelRequest.status, 'Em aprovação');
});

test('Delivery creates one private internal draft using Lisbon calendar terms; approval and payments remain controlled', async t => {
  const f = await fixture(t), owner = await setup(f), c = await customer(owner), driver = await person(f, owner, 'motorista'), finance = await person(f, owner, 'financeiro');
  const job = await acceptedJob(owner, c.id, { driverUserId: driver.user.id, vehicle: 'AUTO-DRIVER' }); await action(owner, 'jobs', job.id, 'dispatch'); await action(driver.client, 'jobs', job.id, 'start');
  const missing = await driver.client.call(`/api/jobs/${job.id}/actions`, 'POST', { action: 'deliver' }); assert.equal(missing.status, 400);
  let snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.jobs.find(item => item.id === job.id).status, 'Em curso'); assert.equal(snapshot.invoices.filter(item => item.jobId === job.id).length, 0);
  const deliveryVersion = (await ok(driver.client, '/api/workspace')).jobs.find(item => item.id === job.id).version;
  const delivery = { action: 'deliver', version: deliveryVersion, pod: { recipient: 'Cliente final', reference: 'POD-AUTO-1', deliveredAt: '2026-03-28T23:30:00.000Z' } };
  const results = await Promise.all([driver.client.call(`/api/jobs/${job.id}/actions`, 'POST', delivery), driver.client.call(`/api/jobs/${job.id}/actions`, 'POST', delivery)]); assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const operationalResponse = results.find(item => item.status === 200).body;
  assert.ok(!('invoice' in operationalResponse)); assert.ok(!('priceCents' in operationalResponse.job)); assert.ok(!('paymentStatus' in operationalResponse.job)); assert.ok(!JSON.stringify(operationalResponse).includes('amountCents'));
  const driverView = await ok(driver.client, '/api/workspace'); assert.equal(driverView.invoices.length, 0); assert.ok(!('workflows' in driverView)); assert.ok(!('configuration' in driverView)); assert.equal((await driver.client.call('/api/workflows')).status, 403);
  snapshot = await ok(owner, '/api/workspace'); const invoice = snapshot.invoices.find(item => item.jobId === job.id); assert.ok(invoice); assert.equal(snapshot.invoices.filter(item => item.jobId === job.id).length, 1); assert.equal(invoice.status, 'Rascunho'); assert.equal(invoice.dueDate, '2026-04-27', 'Terms use calendar days across the Lisbon daylight-saving change.'); assert.equal(invoice.amountCents, 100000); assert.match(invoice.documentType, /não é fatura fiscal/); assert.deepEqual(invoice.payments, []);
  assert.equal((await driver.client.call(`/api/invoices/${invoice.id}`, 'PUT', { dueDate: '2026-04-30', reason: 'Alteração não autorizada.' })).status, 403);
  const corrected = await ok(finance.client, `/api/invoices/${invoice.id}`, 'PUT', { dueDate: '2026-04-30', reason: 'Prazo acordado expressamente com o cliente.' }); assert.equal(corrected.invoice.dueDate, '2026-04-30'); assert.equal(corrected.invoice.status, 'Rascunho'); assert.equal(corrected.invoice.amountCents, invoice.amountCents);
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}`, 'PUT', { version: invoice.version, dueDate: '2026-05-01', reason: 'Pedido com versão desatualizada.' })).status, 409);
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}`, 'PUT', { dueDate: '2026-04-30', amountCents: 1, reason: 'Tentativa de alterar o preço aprovado.' })).status, 409);
  assert.equal((await finance.client.call('/api/invoices', 'POST', { jobId: job.id, dueDate: '2026-04-27' })).status, 409);
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'issue' })).status, 409);
  await action(finance.client, 'invoices', invoice.id, 'submit'); assert.equal((await finance.client.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'approve', ...OVERRIDE })).status, 403);
  const submitted = (await ok(owner, '/api/workspace')).invoices.find(item => item.id === invoice.id), modalConfiguration = await ok(owner, '/api/workflows');
  assert.equal((await owner.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'approve', version: submitted.version })).status, 409, 'Approval must include the workflow policy shown to its reviewer.');
  await settings(owner, { ...RULES, invoiceApprovedToIssued: false });
  assert.equal((await owner.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'approve', version: submitted.version, workflowVersion: modalConfiguration.configuration.version })).status, 409, 'A changed automatic-issuance policy invalidates an open approval.');
  const afterRace = (await ok(owner, '/api/workspace')).invoices.find(item => item.id === invoice.id); assert.equal(afterRace.status, 'Em aprovação'); assert.ok(!afterRace.approvedBy); assert.ok(!afterRace.issuedAt);
  await settings(owner, RULES);
  const approved = await action(owner, 'invoices', invoice.id, 'approve'); assert.equal(approved.invoice.status, 'Emitida'); assert.equal(approved.invoice.approvedBy, (await ok(owner, '/api/session')).user.id); assert.ok(approved.invoice.issuedAt); assert.ok(approved.invoice.approval);
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}`, 'PUT', { dueDate: '2026-05-01', reason: 'Prazo bloqueado após aprovação.' })).status, 409);
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'issue' })).status, 409);
  const partial = await action(finance.client, 'invoices', invoice.id, 'pay', { amount: '300', paymentReference: 'BANK-AUTO-PARTIAL', paymentDate: '2026-04-01' }); assert.equal(partial.invoice.status, 'Emitida'); assert.equal(partial.job.paymentStatus, 'Parcial');
  assert.equal((await finance.client.call(`/api/invoices/${invoice.id}/actions`, 'POST', { action: 'pay', amount: '701', paymentReference: 'BANK-EXCESS' })).status, 409);
  const paid = await action(finance.client, 'invoices', invoice.id, 'pay', { amount: '700', paymentReference: 'BANK-AUTO-FINAL', paymentDate: '2026-04-02' }); assert.equal(paid.invoice.status, 'Paga'); assert.equal(paid.job.paymentStatus, 'Pago');
  snapshot = await ok(owner, '/api/workspace'); const autoDraft = snapshot.audit.filter(item => item.event === 'workflow.transition' && item.details.ruleId === 'deliveryToInvoiceDraft'); const autoIssue = snapshot.audit.filter(item => item.event === 'workflow.transition' && item.details.ruleId === 'invoiceApprovedToIssued'); assert.equal(autoDraft.length, 1); assert.equal(autoDraft[0].details.initiatorId, driver.user.id); assert.equal(autoIssue.length, 1); assert.equal(autoIssue[0].details.initiatorRole, 'gerente'); assert.equal(snapshot.audit.filter(item => item.event === 'invoice.pay' && item.entityId === invoice.id).length, 2);
  const balanceTransitions = snapshot.audit.filter(item => item.event === 'workflow.transition' && item.details.ruleId === 'paymentRecordedToBalance');
  assert.equal(balanceTransitions.length, 3); assert.ok(balanceTransitions.every(item => item.actorRole === 'sistema' && item.details.initiatorId === finance.user.id));
  assert.deepEqual(balanceTransitions.filter(item => item.entityType === 'job').map(item => item.details.nextState).sort(), ['Parcial', 'Pago'].sort());
  const closingTransition = balanceTransitions.find(item => item.entityType === 'invoice'); assert.equal(closingTransition.details.previousState, 'Emitida'); assert.equal(closingTransition.details.nextState, 'Paga');
  const lateLisbon = await deliveredJob(owner, c.id, '2026-03-29T23:30:00.000Z'); snapshot = await ok(owner, '/api/workspace'); const ownInvoice = snapshot.invoices.find(item => item.jobId === lateLisbon.id); assert.equal(ownInvoice.dueDate, '2026-04-29', 'Lisbon POD date may be the day after its UTC date.');
  await action(owner, 'invoices', ownInvoice.id, 'submit'); assert.equal((await owner.call(`/api/invoices/${ownInvoice.id}/actions`, 'POST', { action: 'approve' })).status, 409, 'Automation retains its initiator for the independence-of-approval rule.');
  const ownApproved = await action(owner, 'invoices', ownInvoice.id, 'approve', OVERRIDE); assert.equal(ownApproved.invoice.status, 'Emitida'); assert.equal(ownApproved.invoice.approval.ownerOverride, true);
});

test('Rule changes affect future events only, and legacy POD registration does not fabricate prior activity', async t => {
  const f = await fixture(t), owner = await setup(f), c = await customer(owner); await settings(owner, OFF, 14);
  const oldQuote = await approvedQuote(owner, c.id); const accepted = await action(owner, 'quotes', oldQuote.id, 'accept', { acceptanceReference: 'Aceite antes da ativação' }); assert.equal(accepted.quote.status, 'Aceite'); assert.ok(!accepted.job);
  await settings(owner, RULES, 14); let snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.quotes.find(item => item.id === oldQuote.id).status, 'Aceite'); assert.ok(!snapshot.jobs.some(item => item.quoteId === oldQuote.id)); assert.equal(snapshot.invoices.length, 0);
  const manualJob = (await action(owner, 'quotes', oldQuote.id, 'convert', { driver: 'Sergiu Sandu', vehicle: 'MANUAL-OLD' })).job; await action(owner, 'jobs', manualJob.id, 'dispatch'); await action(owner, 'jobs', manualJob.id, 'start');
  await settings(owner, { ...RULES, deliveryToInvoiceDraft: false }, 14); await action(owner, 'jobs', manualJob.id, 'deliver', { pod: { recipient: 'Cliente', reference: 'POD-MANUAL-OLD', deliveredAt: '2026-03-29T23:30:00.000Z' } });
  await settings(owner, RULES, 14); snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.invoices.filter(item => item.jobId === manualJob.id).length, 0);
  const manualInvoice = (await ok(owner, '/api/invoices', 'POST', { jobId: manualJob.id, dueDate: '2026-04-13' }, 201)).invoice; await action(owner, 'invoices', manualInvoice.id, 'submit');
  await settings(owner, { ...RULES, invoiceApprovedToIssued: false }, 14); await action(owner, 'invoices', manualInvoice.id, 'approve', OVERRIDE); await settings(owner, RULES, 14);
  snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.invoices.find(item => item.id === manualInvoice.id).status, 'Aprovada', 'Rule activation does not issue previously approved records.'); await action(owner, 'invoices', manualInvoice.id, 'issue');
  const legacy = snapshot.jobs.find(item => item.legacyImported && item.status === 'Concluído' && !item.pod); assert.ok(legacy);
  assert.equal((await owner.call('/api/invoices', 'POST', { jobId: legacy.id, dueDate: '2026-04-13' })).status, 409);
  await action(owner, 'jobs', legacy.id, 'registerPod', { pod: { recipient: 'Destinatário confirmado', reference: 'POD-LEGACY', deliveredAt: '2026-03-29T23:30:00.000Z' } });
  assert.equal((await owner.call(`/api/jobs/${legacy.id}/actions`, 'POST', { action: 'registerPod', pod: { recipient: 'Duplicado', reference: 'POD-DUPLICATE' } })).status, 409);
  snapshot = await ok(owner, '/api/workspace'); const drafts = snapshot.invoices.filter(item => item.jobId === legacy.id); assert.equal(drafts.length, 1); assert.equal(drafts[0].status, 'Rascunho'); assert.equal(drafts[0].dueDate, '2026-04-13'); assert.equal(snapshot.jobs.find(item => item.id === legacy.id).legacyPaymentStatus, legacy.legacyPaymentStatus); assert.deepEqual(drafts[0].payments, []);
  assert.equal(snapshot.audit.filter(item => item.event === 'workflow.transition' && item.details.ruleId === 'deliveryToInvoiceDraft').length, 1);
});

test('Automatic cascades are atomic when persistence fails and do not consume references', async t => {
  const f = await fixture(t), owner = await setup(f), c = await customer(owner), quotation = await approvedQuote(owner, c.id);
  const previous = await readFile(f.file, 'utf8'), before = JSON.parse(previous), backup = join(f.dir, 'preserved.json');
  await rename(f.file, backup); await mkdir(f.file);
  let failed;
  try { failed = await owner.call(`/api/quotes/${quotation.id}/actions`, 'POST', { action: 'accept', acceptanceReference: 'Tentativa com disco indisponível' }); }
  finally { await rmdir(f.file); await rename(backup, f.file); }
  assert.equal(failed.status, 500); assert.equal(await readFile(f.file, 'utf8'), previous);
  let snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.quotes.find(item => item.id === quotation.id).status, 'Aprovada'); assert.ok(!snapshot.jobs.some(item => item.quoteId === quotation.id)); assert.ok(!snapshot.audit.some(item => item.event === 'workflow.transition' && item.details.ruleId === 'quoteAcceptedToJob'));
  const retry = await action(owner, 'quotes', quotation.id, 'accept', { acceptanceReference: 'Aceitação após recuperação do disco', driver: 'Sergiu Sandu', vehicle: 'ATOMIC-1' }); assert.equal(retry.job.reference, `TSS-${String(before.nextNumber).padStart(4, '0')}`);
  await action(owner, 'jobs', retry.job.id, 'dispatch'); await action(owner, 'jobs', retry.job.id, 'start');
  const beforeDelivery = await readFile(f.file, 'utf8'); await rename(f.file, backup); await mkdir(f.file);
  try { failed = await owner.call(`/api/jobs/${retry.job.id}/actions`, 'POST', { action: 'deliver', pod: { recipient: 'Cliente', reference: 'POD-ATOMIC', deliveredAt: '2026-03-28T23:30:00.000Z' } }); }
  finally { await rmdir(f.file); await rename(backup, f.file); }
  assert.equal(failed.status, 500); assert.equal(await readFile(f.file, 'utf8'), beforeDelivery);
  snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.jobs.find(item => item.id === retry.job.id).status, 'Em curso'); assert.equal(snapshot.jobs.find(item => item.id === retry.job.id).pod, null); assert.equal(snapshot.invoices.length, 0);
  await action(owner, 'jobs', retry.job.id, 'deliver', { pod: { recipient: 'Cliente', reference: 'POD-ATOMIC', deliveredAt: '2026-03-28T23:30:00.000Z' } });
  snapshot = await ok(owner, '/api/workspace'); assert.equal(snapshot.invoices.length, 1); assert.equal(snapshot.invoices[0].reference, 'INT-0001');
});

test('Automatic internal issuance rechecks source evidence and amount, rolling back invalid approvals', async t => {
  const f = await fixture(t), owner = await setup(f), c = await customer(owner), job = await deliveredJob(owner, c.id);
  const draft = (await ok(owner, '/api/workspace')).invoices.find(item => item.jobId === job.id); await action(owner, 'invoices', draft.id, 'submit');
  const validBytes = await readFile(f.file, 'utf8');
  for (const invalidate of [store => { store.jobs.find(item => item.id === job.id).pod = null; }, store => { store.jobs.find(item => item.id === job.id).priceCents += 1; }]) {
    await f.stop(); const broken = JSON.parse(validBytes); invalidate(broken); await writeFile(f.file, JSON.stringify(broken)); await f.start(); await owner.login('sergiu');
    const rejected = await owner.call(`/api/invoices/${draft.id}/actions`, 'POST', { action: 'approve', ...OVERRIDE }); assert.equal(rejected.status, 409);
    const snapshot = await ok(owner, '/api/workspace'), invoice = snapshot.invoices.find(item => item.id === draft.id); assert.equal(invoice.status, 'Em aprovação'); assert.ok(!invoice.approvedBy); assert.ok(!invoice.approval); assert.ok(!invoice.issuedAt); assert.ok(!snapshot.audit.some(item => item.event === 'workflow.transition' && item.details.ruleId === 'invoiceApprovedToIssued'));
  }
  await f.stop(); await writeFile(f.file, validBytes); await f.start(); await owner.login('sergiu');
  const approved = await action(owner, 'invoices', draft.id, 'approve', OVERRIDE); assert.equal(approved.invoice.status, 'Emitida'); assert.equal(approved.invoice.amountCents, job.priceCents);
});
