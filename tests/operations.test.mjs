import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { initialWorkflowConfiguration } from '../lib/workflows.mjs';
import { workspace, saveJob, jobAction, dispatchReadiness } from '../lib/business.mjs';
import { loadStore, prepareStoreForMigration } from '../lib/storage.mjs';
import { createPostgresRepository } from '../lib/postgres-storage.mjs';
import { ensureOperationalCollections, saveVehicle, saveDriver, saveOpportunity, opportunityAction, saveCost, saveIncident, incidentAction } from '../lib/operations.mjs';

const credential = { algorithm: 'scrypt', salt: '1'.repeat(32), hash: '2'.repeat(128), N: 131072, r: 8, p: 1 };
function fixture() {
  const manager = { id: randomUUID(), username: 'manager', name: 'Sergiu Sandu', role: 'gerente', active: true, version: 1, password: { ...credential } };
  const driver = { id: randomUUID(), username: 'driver', name: 'João Martins', role: 'motorista', active: true, version: 1, password: { ...credential } };
  const commercial = { id: randomUUID(), username: 'sales', name: 'Comercial', role: 'comercial', active: true, version: 1, password: { ...credential } };
  const customer = { id: randomUUID(), name: 'Adega de teste', creditLimitCents: 0, taxId: '', ownerId: null, version: 1 };
  const first = { id: randomUUID(), reference: 'TSS-0001', customerId: customer.id, customer: customer.name, pickup: 'Alenquer', delivery: 'Lisboa', pickupDate: '2099-01-10', deliveryDate: '2099-01-10', driver: driver.name, driverUserId: driver.id, vehicle: 'AA-01-TS', priceCents: 32000, status: 'Agendado', paymentStatus: 'Pendente', version: 1, pod: null };
  const second = { ...first, id: randomUUID(), reference: 'TSS-0002', driver: 'Outro motorista', driverUserId: null, vehicle: 'AA-02-TS' };
  const store = { schemaVersion: 2, nextNumber: 3, counters: { quotes: 1, workOrders: 1, invoices: 1 }, users: [manager, driver, commercial], customers: [customer], jobs: [first, second], quotes: [], yard: [], workOrders: [], invoices: [], audit: [], workflowConfiguration: initialWorkflowConfiguration() };
  ensureOperationalCollections(store);
  return { store, manager, driver, commercial, customer, first, second };
}
function register(context) {
  const { store, manager, driver } = context;
  const vehicle = saveVehicle(store, manager, { registration: 'AA-01-TS', capacityKg: 1000, capacityPallets: 10, status: 'Disponível', inspectionDueDate: '2100-01-01', insuranceDueDate: '2100-01-01', odometerKm: 10000, nextServiceKm: 20000 }).vehicle;
  const profile = saveDriver(store, manager, { name: driver.name, userId: driver.id, status: 'Ativo', licenseExpiryDate: '2100-01-01' }).driver;
  return { vehicle, profile };
}
const rejects = (fn, status) => assert.throws(fn, error => error.status === status);

test('Registered resources derive identity, enforce capacity/documents and recheck expiry after dispatch', () => {
  const context = fixture(); const { store, manager, driver, first } = context;
  const { vehicle, profile } = register(context);
  rejects(() => saveJob(store, manager, first.id, { version: first.version, vehicleId: vehicle.id, vehicle: 'WRONG' }), 400);
  rejects(() => saveJob(store, manager, first.id, { version: first.version, driverId: profile.id, driverUserId: manager.id }), 400);
  saveJob(store, manager, first.id, { version: first.version, vehicleId: vehicle.id, driverId: profile.id, weightKg: 1001, pallets: 2, pickupTime: '08:00', deliveryTime: '09:00' });
  assert.equal(first.vehicle, vehicle.registration); assert.equal(first.driverUserId, driver.id);
  assert.ok(dispatchReadiness(store, first).blockers.some(row => row.code === 'weight_capacity'));
  rejects(() => jobAction(store, manager, first.id, { action: 'dispatch', version: first.version }), 409);
  saveJob(store, manager, first.id, { version: first.version, weightKg: 500 });
  jobAction(store, manager, first.id, { action: 'dispatch', version: first.version });
  saveVehicle(store, manager, { version: vehicle.version, insuranceDueDate: '2000-01-01' }, vehicle.id);
  rejects(() => jobAction(store, driver, first.id, { action: 'start', version: first.version }), 409);
  assert.equal(first.status, 'Agendado');
  saveVehicle(store, manager, { version: vehicle.version, insuranceDueDate: '2100-01-01' }, vehicle.id);
  saveDriver(store, manager, { version: profile.version, status: 'Suspenso' }, profile.id);
  rejects(() => jobAction(store, driver, first.id, { action: 'start', version: first.version }), 409);
  saveDriver(store, manager, { version: profile.version, status: 'Ativo', licenseExpiryDate: '2099-01-09' }, profile.id);
  assert.ok(dispatchReadiness(store, first).blockers.some(row => row.code === 'license_expired'));
});

test('Timed bookings allow touching endpoints, block overlap and preserve full-day legacy reservations', () => {
  const { store, manager, first, second } = fixture();
  saveJob(store, manager, first.id, { version: first.version, pickupTime: '08:00', deliveryTime: '09:00', cargo: 'Vinho', weightKg: 300, pallets: 2, instructions: 'Entregar na portaria' });
  jobAction(store, manager, first.id, { action: 'dispatch', version: first.version });
  saveJob(store, manager, second.id, { version: second.version, vehicle: first.vehicle, pickupTime: '09:00', deliveryTime: '10:00' });
  assert.equal(dispatchReadiness(store, second).ready, true);
  saveJob(store, manager, second.id, { version: second.version, pickupTime: '08:59' });
  assert.ok(dispatchReadiness(store, second).blockers.some(row => row.code === 'resource_overlap'));
  rejects(() => jobAction(store, manager, second.id, { action: 'dispatch', version: second.version }), 409);
  saveJob(store, manager, second.id, { version: second.version, pickupTime: '', deliveryTime: '' });
  assert.ok(dispatchReadiness(store, second).blockers.some(row => row.code === 'resource_overlap'));
  rejects(() => saveJob(store, manager, second.id, { version: second.version, pickupTime: '25:00', deliveryTime: '12:00' }), 400);
  rejects(() => saveJob(store, manager, second.id, { version: second.version, pickupTime: '11:00', deliveryTime: '10:00' }), 400);
});

test('CRM records follow-ups, versions, closing reasons and activities without granting dispatch or price authority', () => {
  const { store, commercial, driver, customer } = fixture();
  const opportunity = saveOpportunity(store, commercial, { customerId: customer.id, title: 'Transporte semanal', expectedValue: '1200,50', nextFollowUpDate: '2026-01-01' }).opportunity;
  assert.equal(opportunity.expectedValueCents, 120050);
  opportunityAction(store, commercial, opportunity.id, { version: opportunity.version, action: 'activity', type: 'Chamada', description: 'Cliente pediu proposta semanal', dueDate: '2026-01-01' });
  assert.equal(store.activities.length, 1);
  rejects(() => opportunityAction(store, commercial, opportunity.id, { version: 1, action: 'stage', status: 'Proposta' }), 409);
  opportunityAction(store, commercial, opportunity.id, { version: opportunity.version, action: 'stage', status: 'Proposta' });
  rejects(() => opportunityAction(store, commercial, opportunity.id, { version: opportunity.version, action: 'stage', status: 'Ganho', reason: '' }), 400);
  opportunityAction(store, commercial, opportunity.id, { version: opportunity.version, action: 'stage', status: 'Ganho', reason: 'Contrato aceite pelo cliente' });
  rejects(() => saveOpportunity(store, commercial, { version: opportunity.version, title: 'Alteração' }, opportunity.id), 409);
  rejects(() => saveOpportunity(store, driver, { customerId: customer.id, title: 'Não autorizado' }), 403);
  assert.equal(workspace(store, driver).opportunities.length, 0);
  assert.equal(store.jobs.length, 2);
});

test('Actual cost contributions and private attachment storage never leak to drivers; correction is audited', () => {
  const { store, manager, driver, first } = fixture();
  const cost = saveCost(store, manager, { jobId: first.id, category: 'Combustível', amount: '100,25', date: '2026-01-01', reference: 'FUEL-001', supplier: 'Posto de teste' }).cost;
  assert.equal(workspace(store, manager).contributions.find(row => row.jobId === first.id).contributionCents, 21975);
  const attachment = { id: randomUUID(), jobId: first.id, storageKey: 'private.bin', kind: 'pod-photo', name: 'POD.jpg', version: 1 };
  store.attachments.push(attachment);
  store.mobileOperations.push({ id: randomUUID(), userId: driver.id, operationId: randomUUID(), result: { secretFinancialValue: 42 }, version: 1 });
  const driverView = workspace(store, driver);
  assert.equal(driverView.costs.length, 0); assert.equal(driverView.contributions, undefined); assert.equal(driverView.managerDashboard, undefined); assert.equal(driverView.mobileOperations, undefined);
  assert.equal(driverView.jobs[0].priceCents, undefined); assert.equal(driverView.attachments[0].storageKey, undefined);
  rejects(() => saveCost(store, driver, { jobId: first.id, category: 'Outros', amount: '10', date: '2026-01-01', reference: 'X' }), 403);
  rejects(() => saveCost(store, manager, { jobId: first.id, category: 'Combustível', amount: '100,25', date: '2026-01-01', reference: 'fuel-001', supplier: 'Posto de teste' }), 409);
  rejects(() => saveCost(store, manager, { version: cost.version, amount: '90', reason: 'curto' }, cost.id), 400);
  saveCost(store, manager, { version: cost.version, amount: '90', reason: 'Correção do recibo recebido' }, cost.id);
  assert.equal(store.audit.at(-1).details.before.amountCents, 10025);
});

test('Incidents are scoped to assigned jobs and need an authorized, versioned resolution', () => {
  const { store, manager, driver, first, second } = fixture();
  rejects(() => saveIncident(store, driver, { jobId: second.id, type: 'delay', severity: 'low', description: 'Atraso na portaria do cliente' }), 403);
  const incident = saveIncident(store, driver, { jobId: first.id, type: 'delay', severity: 'low', description: 'Atraso na portaria do cliente' }).incident;
  rejects(() => incidentAction(store, driver, incident.id, { action: 'resolve', version: incident.version, resolution: 'Cliente informado' }), 403);
  incidentAction(store, manager, incident.id, { action: 'investigate', version: incident.version });
  rejects(() => saveIncident(store, driver, { version: incident.version, description: 'Já em tratamento' }, incident.id), 409);
  rejects(() => incidentAction(store, manager, incident.id, { action: 'resolve', version: 1, resolution: 'Cliente informado' }), 409);
  incidentAction(store, manager, incident.id, { action: 'resolve', version: incident.version, resolution: 'Cliente informado e nova janela acordada' });
  assert.equal(incident.status, 'Resolvida'); assert.equal(store.audit.at(-1).event, 'incident.resolve');
});

test('An approved cancellation excludes its quotation from contribution revenue but retains incurred costs', () => {
  const { store, manager, first } = fixture();
  saveCost(store, manager, { jobId: first.id, category: 'Combustível', amount: '50', date: '2026-01-01', reference: 'CANCELED-FUEL-001' });
  jobAction(store, manager, first.id, { action: 'cancel', version: first.version, reason: 'Cliente cancelou a recolha' });
  jobAction(store, manager, first.id, { action: 'approveCancel', version: first.version, ownerOverride: true, reason: 'Confirmo o cancelamento recebido do cliente e preservo o custo efetivo.' });
  const contribution = workspace(store, manager).contributions.find(row => row.jobId === first.id);
  assert.equal(first.priceCents, 32000);
  assert.equal(contribution.status, 'Cancelado');
  assert.equal(contribution.revenueCents, 0);
  assert.equal(contribution.costCents, 5000);
  assert.equal(contribution.contributionCents, -5000);
  assert.equal(contribution.costCount, 1);
});

test('POD attachment references must belong to the job and remain stored after delivery', () => {
  const { store, manager, driver, first, second } = fixture();
  const own = { id: randomUUID(), jobId: first.id, version: 1 }, other = { id: randomUUID(), jobId: second.id, version: 1 };
  store.attachments.push(own, other);
  jobAction(store, manager, first.id, { action: 'dispatch', version: first.version });
  jobAction(store, driver, first.id, { action: 'start', version: first.version });
  const pod = { recipient: 'Cliente de teste', reference: 'POD-001', deliveredAt: '2026-01-01T10:00:00Z', attachmentIds: [other.id] };
  rejects(() => jobAction(store, driver, first.id, { action: 'deliver', version: first.version, pod }), 400);
  jobAction(store, driver, first.id, { action: 'deliver', version: first.version, pod: { ...pod, attachmentIds: [own.id] } });
  assert.deepEqual(first.pod.attachmentIds, [own.id]);
  assert.equal(first.status, 'Concluído');
});

test('Operational JSON upgrade backs up exact original bytes, preserves credentials and does not repeat its audit event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tss-operations-test-'));
  try {
    const { store, manager } = fixture();
    for (const key of ['vehicles', 'drivers', 'opportunities', 'activities', 'incidents', 'costs', 'attachments', 'mobileOperations']) delete store[key];
    const original = JSON.stringify(store, null, 2) + '\n'; const file = join(directory, 'jobs.json');
    await writeFile(file, original);
    const loaded = await loadStore(file);
    const upgrade = loaded.audit.find(row => row.event === 'migration.operations.v3');
    assert.equal(await readFile(upgrade.details.backupFile, 'utf8'), original);
    assert.deepEqual(loaded.users.find(user => user.id === manager.id).password, credential);
    assert.deepEqual(loaded.jobs, store.jobs);
    assert.equal((await loadStore(file)).audit.filter(row => row.event === 'migration.operations.v3').length, 1);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'tss-operations-test-'))); await rm(directory, { recursive: true, force: true }); }
});

function poolFor(engine) {
  return { async connect() { return { async query(sql, parameters) { if (parameters?.length) return engine.query(sql, parameters); return (await engine.exec(sql)).at(-1) ?? { rows: [] }; }, release() {} }; } };
}
test('Embedded PostgreSQL persists new operational rows, attachment deduplication and confidential mobile receipts', async () => {
  const engine = new PGlite(); let repository;
  try {
    const context = fixture(); const { store, manager, driver, customer, first } = context;
    const { vehicle, profile } = register(context);
    saveJob(store, manager, first.id, { version: first.version, vehicleId: vehicle.id, driverId: profile.id, pickupTime: '08:00', deliveryTime: '09:00' });
    const opportunity = saveOpportunity(store, manager, { customerId: customer.id, title: 'Serviço regular', expectedValue: '320', nextFollowUpDate: '2026-01-01' }).opportunity;
    opportunityAction(store, manager, opportunity.id, { version: opportunity.version, action: 'activity', description: 'Confirmar próxima recolha', dueDate: '2026-01-01' });
    saveCost(store, manager, { jobId: first.id, category: 'Portagens', amount: '12,50', date: '2026-01-01', reference: 'TOLL-001' });
    saveIncident(store, driver, { jobId: first.id, type: 'delay', severity: 'low', description: 'Cliente ainda não preparou a carga' });
    const sha256 = 'a'.repeat(64);
    for (let i = 0; i < 2; i++) store.attachments.push({ id: randomUUID(), jobId: first.id, createdBy: driver.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), kind: 'pod-photo', name: `POD-${i}.jpg`, mimeType: 'image/jpeg', sizeBytes: 100, sha256, storageKey: sha256 + '.bin', operationId: randomUUID(), version: 1 });
    store.mobileOperations.push({ id: randomUUID(), userId: driver.id, operationId: randomUUID(), requestHash: 'b'.repeat(64), scope: 'attachment', result: { attachmentId: store.attachments[0].id }, createdAt: new Date().toISOString(), version: 1 });
    repository = await createPostgresRepository({ pool: poolFor(engine) });
    const expected = prepareStoreForMigration(store);
    await repository.initialize(expected);
    assert.deepEqual(await repository.read(), expected);
    const tables = await engine.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'tss'");
    assert.equal(tables.rows.length, 18);
    await repository.mutate(draft => saveVehicle(draft, manager, { version: vehicle.version, status: 'Indisponível' }, vehicle.id));
    assert.equal((await repository.read()).vehicles[0].status, 'Indisponível');
    const before = await repository.read();
    await assert.rejects(repository.mutate(draft => { draft.mobileOperations.push({ ...draft.mobileOperations[0], id: randomUUID() }); }), error => error.code === '23505');
    assert.deepEqual(await repository.read(), before);
  } finally { await repository?.close(); await engine.close(); }
});
