import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { normalizeJob } from '../public/domain.mjs';
import { initialWorkflowConfiguration, validateWorkflowConfiguration } from './workflows.mjs';
import { ensureOperationalCollections, validateOperationalCollections } from './operations.mjs';

export async function persist(file, store) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await writeFile(temporary, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
function legacySamples() {
  const rows = [
    ['Adega da Encosta', 'Alenquer · Zona Industrial', 'Lisboa · Marvila', '2026-09-28', '2026-09-28', 'João Martins', 'AA-01-TS', '320,00', 'Concluído', 'Pago'],
    ['Armazéns Tejo', 'Vila Franca de Xira · Armazém 2', 'Porto · Campanhã', '2026-09-29', '2026-09-30', 'Ana Ferreira', 'AA-02-TS', '780,00', 'Em curso', 'Pendente'],
    ['Lusitânia Embalagens', 'Torres Vedras · Polo Industrial', 'Setúbal · Mitrena', '2026-09-30', '2026-09-30', 'Miguel Costa', 'AA-03-TS', '450,00', 'Em curso', 'Pendente'],
    ['Mercado do Oeste', 'Alenquer · Carregado', 'Coimbra · Taveiro', '2026-10-01', '2026-10-01', 'João Martins', 'AA-01-TS', '540,00', 'Agendado', 'Pendente'],
    ['Adega da Encosta', 'Alenquer · Zona Industrial', 'Faro · Montenegro', '2026-10-02', '2026-10-02', 'Ana Ferreira', 'AA-02-TS', '860,00', 'Agendado', 'Pendente'],
    ['Armazéns Tejo', 'Lisboa · Prior Velho', 'Braga · Celeirós', '2026-09-25', '2026-09-26', 'Miguel Costa', 'AA-03-TS', '920,00', 'Concluído', 'Em atraso'],
    ['Lusitânia Embalagens', 'Loures · São Julião do Tojal', 'Évora · Zona Industrial', '2026-09-27', '2026-09-27', 'João Martins', 'AA-01-TS', '390,00', 'Cancelado', 'Pendente'],
    ['Mercado do Oeste', 'Torres Vedras · Silveira', 'Leiria · Barosa', '2026-10-05', '2026-10-05', '', '', '410,00', 'Agendado', 'Pendente'],
  ];
  return { schemaVersion: 1, nextNumber: 9, jobs: rows.map((row, index) => ({
    id: randomUUID(), reference: `TSS-${String(index + 1).padStart(4, '0')}`, sample: true,
    ...normalizeJob(Object.fromEntries(['customer', 'pickup', 'delivery', 'pickupDate', 'deliveryDate', 'driver', 'vehicle', 'quotedPrice', 'status', 'paymentStatus'].map((key, i) => [key, row[i]]))),
    createdAt: '2026-09-30T09:00:00.000Z', updatedAt: '2026-09-30T09:00:00.000Z',
  })) };
}
function validateLegacy(store) {
  if (!Number.isSafeInteger(store.nextNumber) || store.nextNumber < 1 || !Array.isArray(store.jobs)) throw new Error('Ficheiro de dados inválido. Os dados foram preservados.');
  const ids = new Set(), references = new Set();
  for (const job of store.jobs) {
    if (typeof job.id !== 'string' || !/^[0-9a-f-]{36}$/.test(job.id) || typeof job.reference !== 'string'
      || !/^TSS-\d{4,}$/.test(job.reference) || ids.has(job.id) || references.has(job.reference)
      || !Number.isSafeInteger(job.priceCents) || job.priceCents < 0
      || Number(job.reference.slice(4)) >= store.nextNumber) throw new Error('Um serviço no ficheiro de dados é inválido. Os dados foram preservados.');
    normalizeJob({ ...job, quotedPrice: (job.priceCents / 100).toFixed(2) });
    ids.add(job.id); references.add(job.reference);
  }
}
function migrateV1(old, backupFile) {
  const at = new Date().toISOString();
  const store = { ...old, schemaVersion: 2, users: [], customers: [], quotes: [], yard: [], workOrders: [], invoices: [], audit: [], workflowConfiguration: initialWorkflowConfiguration(), counters: { quotes: 1, workOrders: 1, invoices: 1 }, migration: { from: 1, at, backupFile, note: 'Estados de pagamento antigos preservados em legacyPaymentStatus; cobrança corrente calculada a partir de registos internos aprovados. Não foram criadas faturas nem comprovativos fictícios.' } };
  const byName = new Map();
  for (const job of store.jobs) {
    const key = job.customer.toLocaleLowerCase('pt-PT');
    let customer = byName.get(key);
    if (!customer) {
      customer = { id: randomUUID(), name: job.customer, taxId: '', contact: '', email: '', phone: '', creditLimitCents: 0, ownerId: null, createdBy: null, sample: !!job.sample, createdAt: at, updatedAt: at, version: 1 };
      store.customers.push(customer); byName.set(key, customer);
    }
    job.customerId = customer.id;
    job.driverUserId = null;
    job.legacyPaymentStatus = job.paymentStatus;
    job.paymentStatus = 'Pendente';
    job.legacyImported = true;
    job.pod = null;
    job.version = 1;
  }
  store.audit.push({ id: randomUUID(), at, actorId: null, actorName: 'Sistema', actorRole: 'sistema', event: 'migration.v1.v2', entityType: 'system', entityId: null, details: { backupFile, jobCount: store.jobs.length } });
  return store;
}
function validateV2(store) {
  if (store.schemaVersion !== 2 || !Number.isSafeInteger(store.nextNumber) || store.nextNumber < 1 || !store.counters) throw new Error('Ficheiro de dados inválido. Os dados foram preservados.');
  for (const key of ['users', 'customers', 'jobs', 'quotes', 'yard', 'workOrders', 'invoices', 'audit']) {
    if (!Array.isArray(store[key])) throw new Error(`Coleção ${key} inválida. Os dados foram preservados.`);
    const ids = new Set();
    for (const item of store[key]) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw new Error(`Registo ${key} inválido. Os dados foram preservados.`);
      ids.add(item.id);
      if (key !== 'audit' && item.version == null) item.version = 1;
    }
  }
  for (const key of ['quotes', 'workOrders', 'invoices']) if (!Number.isSafeInteger(store.counters[key]) || store.counters[key] < 1) throw new Error('Contador inválido. Os dados foram preservados.');
  const usernames = new Set();
  for (const user of store.users) {
    if (typeof user.username !== 'string' || usernames.has(user.username) || typeof user.active !== 'boolean'
      || user.password?.algorithm !== 'scrypt' || !/^[0-9a-f]{32}$/.test(user.password.salt) || !/^[0-9a-f]{128}$/.test(user.password.hash)
      || user.password.N !== 131072 || user.password.r !== 8 || user.password.p !== 1) throw new Error('Credencial inválida. Os dados foram preservados.');
    usernames.add(user.username);
  }
  if (store.users.length && !store.users.some(user => user.role === 'gerente' && user.active)) throw new Error('É obrigatório manter pelo menos um gerente ativo. Os dados foram preservados.');
  validateWorkflowConfiguration(store.workflowConfiguration);
  validateOperationalCollections(store);
}
// Validate imports without opening, seeding or rewriting the source JSON file.
export function prepareStoreForMigration(parsed, { backupFile = null } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Ficheiro de dados inválido. Os dados foram preservados.');
  let store = structuredClone(parsed);
  if (store.schemaVersion === 1) {
    validateLegacy(store);
    store = migrateV1(store, backupFile);
  } else if (store.schemaVersion === 2 && store.workflowConfiguration === undefined) {
    store.workflowConfiguration = initialWorkflowConfiguration();
    store.audit?.push({ id: randomUUID(), at: new Date().toISOString(), actorId: null, actorName: 'Sistema', actorRole: 'sistema', event: 'workflow.settings.initialize', entityType: 'workflowConfiguration', entityId: 'business', details: { configuration: store.workflowConfiguration, futureTriggersOnly: true } });
  }
  validateV2(store);
  return store;
}
export function validateStore(store) {
  validateV2(store);
  return store;
}
export async function loadStore(file) {
  let bytes, parsed;
  try { bytes = await readFile(file, 'utf8'); parsed = JSON.parse(bytes); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Não foi possível ler ${file}. O ficheiro foi preservado. ${error.message}`);
    parsed = migrateV1(legacySamples(), null);
    ensureOperationalCollections(parsed);
    await persist(file, parsed);
    return parsed;
  }
  if (parsed.schemaVersion === 1) {
    validateLegacy(parsed);
    const backupFile = `${file}.v1-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
    await writeFile(backupFile, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    parsed = migrateV1(parsed, backupFile);
    validateV2(parsed);
    await persist(file, parsed);
  } else {
    const needsWorkflowConfiguration = parsed.workflowConfiguration === undefined;
    const needsOperationalCollections = ensureOperationalCollections(parsed);
    let operationsBackup = null;
    if (needsOperationalCollections) {
      operationsBackup = `${file}.v2-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
      await writeFile(operationsBackup, bytes, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    if (needsWorkflowConfiguration) parsed.workflowConfiguration = initialWorkflowConfiguration();
    validateV2(parsed);
    if (needsWorkflowConfiguration) {
      parsed.audit.push({ id: randomUUID(), at: new Date().toISOString(), actorId: null, actorName: 'Sistema', actorRole: 'sistema', event: 'workflow.settings.initialize', entityType: 'workflowConfiguration', entityId: 'business', details: { configuration: parsed.workflowConfiguration, futureTriggersOnly: true } });
    }
    if (needsOperationalCollections) parsed.audit.push({ id: randomUUID(), at: new Date().toISOString(), actorId: null, actorName: 'Sistema', actorRole: 'sistema', event: 'migration.operations.v3', entityType: 'system', entityId: null, details: { backupFile: operationsBackup, collections: ['vehicles', 'drivers', 'opportunities', 'activities', 'incidents', 'costs', 'attachments', 'mobileOperations'], preservedExistingRecords: true } });
    if (needsWorkflowConfiguration || needsOperationalCollections) await persist(file, parsed);
  }
  return parsed;
}
