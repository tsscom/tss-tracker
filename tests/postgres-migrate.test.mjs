import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runMigration, canonicalStore } from '../tools/postgres-migrate.mjs';
import { loadLocalEnv } from '../tools/postgres-env.mjs';
import { initialWorkflowConfiguration } from '../lib/workflows.mjs';

const FIXTURE_CONNECTION = 'postgresql://fixture:never-an-actual-password@127.0.0.1:5432/fixture';
const OPERATIONAL_COLLECTIONS = ['vehicles', 'drivers', 'opportunities', 'activities', 'incidents', 'costs', 'attachments', 'mobileOperations'];
function assertAdditiveUpgrade(imported, original) {
  // Keep the fixture in the original v2 format. Import preparation adds only
  // empty operational collections, preserving every original value verbatim.
  for (const [key, value] of Object.entries(original)) assert.deepEqual(imported[key], value, `Original field ${key} was changed`);
  for (const key of OPERATIONAL_COLLECTIONS) assert.deepEqual(imported[key], [], `New collection ${key} must initially be empty`);
  assert.deepEqual(Object.keys(imported).sort(), [...Object.keys(original), ...OPERATIONAL_COLLECTIONS].sort());
  const originalFields = Object.fromEntries(Object.entries(imported).filter(([key]) => !OPERATIONAL_COLLECTIONS.includes(key)));
  assert.equal(canonicalStore(originalFields), canonicalStore(original));
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tss-postgres-migrate-test-'));
  t.after(async () => {
    // Cleanup is limited to the generated test directory inside the OS temp root.
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const at = '2026-09-30T12:34:56.000Z';
  const store = {
    schemaVersion: 2, nextNumber: 2, counters: { quotes: 2, workOrders: 2, invoices: 2 },
    users: [{ id: randomUUID(), name: 'Gerente fictício', username: 'fixture.manager', role: 'gerente', active: true,
      password: { algorithm: 'scrypt', N: 131072, r: 8, p: 1, salt: 'ab'.repeat(16), hash: 'cd'.repeat(64) },
      securityVersion: 7, version: 4, createdAt: at, updatedAt: at }],
    customers: [{ id: randomUUID(), name: 'Cliente fictício Évora', taxId: '', contact: 'Teste', creditLimitCents: 0, version: 3, createdAt: at, updatedAt: at }],
    jobs: [{ id: randomUUID(), reference: 'TSS-0001', customer: 'Cliente fictício Évora', pickup: 'Alenquer', delivery: 'Évora',
      pickupDate: '2026-10-01', deliveryDate: '2026-10-02', priceCents: 12345, status: 'Agendado', paymentStatus: 'Pendente', version: 6,
      extension: { note: 'Preservar todos os campos', tags: ['Portugal', 'euros'] }, createdAt: at, updatedAt: at }],
    quotes: [{ id: randomUUID(), reference: 'PROP-0001', status: 'Rascunho', priceCents: 12345, version: 2 }],
    yard: [{ id: randomUUID(), vehicle: 'TEST-01', location: 'Posição 1', version: 3 }],
    workOrders: [{ id: randomUUID(), reference: 'OF-0001', vehicle: 'TEST-02', status: 'Rascunho', estimatedCostCents: 5000, version: 2 }],
    invoices: [{ id: randomUUID(), reference: 'INT-0001', status: 'Rascunho', amountCents: 12345, version: 2, payments: [] }],
    audit: [{ id: randomUUID(), at, event: 'fixture.first', details: { nested: { retained: true } } },
      { id: randomUUID(), at, event: 'fixture.second', details: { sequence: 2 } }],
    workflowConfiguration: initialWorkflowConfiguration(),
    migration: { from: 1, at, backupFile: 'fixture-only.json', note: 'Preservar a informação antiga.' },
    extensionMetadata: { revision: 42, nested: { values: [null, true, 123, 'Évora'] } },
  };
  const source = join(directory, 'jobs.json');
  const bytes = Buffer.from(JSON.stringify(store, null, 2) + '\n');
  await writeFile(source, bytes);
  return { directory, source, bytes, store };
}

test('Migration dry-run validates and counts without connecting, backing up or changing JSON', async t => {
  const { directory, source, bytes } = await fixture(t);
  let connections = 0;
  const result = await runMigration({ source, repositoryFactory: async () => { connections++; throw new Error('Should never connect'); } });
  assert.equal(result.mode, 'dry-run');
  assert.deepEqual(result.counts, { users: 1, customers: 1, jobs: 1, quotes: 1, yard: 1, workOrders: 1, invoices: 1, audit: 2 });
  assert.equal(connections, 0);
  assert.deepEqual(await readdir(directory), ['jobs.json']);
  assert.ok(bytes.equals(await readFile(source)));
  assert.equal(result.backupPath, undefined);
});

test('Explicit import verifies an exact backup before database writes and retains every field and credential', async t => {
  const { directory, source, bytes, store } = await fixture(t);
  let imported, connections = 0, closes = 0;
  const repositoryFactory = async ({ connectionString }) => {
    connections++;
    assert.equal(connectionString, FIXTURE_CONNECTION);
    const backups = (await readdir(directory)).filter(name => name.includes('.postgres-backup-'));
    assert.equal(backups.length, 1);
    assert.ok(bytes.equals(await readFile(join(directory, backups[0]))));
    return {
      initialize: async expected => { imported = structuredClone(expected); return structuredClone(expected); },
      close: async () => { closes++; },
    };
  };
  const result = await runMigration({ source, apply: true, connectionString: FIXTURE_CONNECTION, repositoryFactory });
  assert.equal(result.verified, true);
  assert.equal(connections, 1);
  assert.equal(closes, 1);
  assertAdditiveUpgrade(imported, store);
  assert.deepEqual(imported.users[0].password, store.users[0].password);
  assert.deepEqual(imported.extensionMetadata, store.extensionMetadata);
  assert.deepEqual(imported.audit.map(event => event.id), store.audit.map(event => event.id));
  assert.ok(bytes.equals(await readFile(source)));
  assert.ok(bytes.equals(await readFile(result.backupPath)));
});

test('Missing, corrupt and invalid sources fail before destination writes or backup creation', async t => {
  const { directory, source } = await fixture(t);
  let calls = 0;
  const options = { apply: true, connectionString: FIXTURE_CONNECTION, repositoryFactory: async () => { calls++; } };
  await assert.rejects(runMigration({ ...options, source: join(directory, 'missing.json') }), /ficheiro existente/);
  for (const bytes of ['{do-not-disclose-this-value', JSON.stringify({ schemaVersion: 2, users: [] })]) {
    await writeFile(source, bytes);
    await assert.rejects(runMigration({ ...options, source }), error => !error.message.includes('do-not-disclose-this-value'));
    assert.equal(await readFile(source, 'utf8'), bytes);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(directory), ['jobs.json']);
});

test('A repeated import refuses an occupied destination without overwriting it or its source', async t => {
  const { source, bytes, store } = await fixture(t);
  let destination = null, closes = 0;
  const repositoryFactory = async () => ({
    initialize: async expected => {
      if (destination) throw Object.assign(new Error('Fixture destination occupied'), { code: 'TSS_DATABASE_NOT_EMPTY' });
      destination = structuredClone(expected);
      return structuredClone(destination);
    },
    close: async () => { closes++; },
  });
  const options = { source, apply: true, connectionString: FIXTURE_CONNECTION, repositoryFactory };
  await runMigration(options);
  await assert.rejects(runMigration(options), { code: 'TSS_DATABASE_NOT_EMPTY' });
  assertAdditiveUpgrade(destination, store);
  assert.equal(closes, 2);
  assert.ok(bytes.equals(await readFile(source)));
});

test('An invalid connection cannot write backups and an unexpected roundtrip mismatch closes the repository', async t => {
  const { directory, source } = await fixture(t);
  let closes = 0;
  await assert.rejects(runMigration({ source, apply: true, connectionString: 'not-a-url' }), /DATABASE_URL/);
  assert.deepEqual(await readdir(directory), ['jobs.json']);
  await assert.rejects(runMigration({ source, apply: true, connectionString: FIXTURE_CONNECTION, repositoryFactory: async () => ({
    initialize: async expected => ({ ...expected, nextNumber: expected.nextNumber + 1 }),
    close: async () => { closes++; },
  }) }), /verificação integral/i);
  assert.equal(closes, 1);
});

test('Local env loader preserves shell values and parses quotes, encoded URL secrets and comments', async t => {
  const { directory } = await fixture(t);
  const envFile = join(directory, '.env');
  await writeFile(envFile, '\uFEFF# Comentário\nPORT=9999\nDATABASE_URL="postgresql://fixture:encoded%23secret@127.0.0.1/fixture" # Comentário\nSTORAGE_BACKEND=postgres# Comentário\nOTHER=\'literal value\'\n');
  const environment = { PORT: '4317' };
  assert.equal(await loadLocalEnv(envFile, environment), true);
  assert.deepEqual(environment, { PORT: '4317', DATABASE_URL: 'postgresql://fixture:encoded%23secret@127.0.0.1/fixture', STORAGE_BACKEND: 'postgres', OTHER: 'literal value' });
  assert.equal(await loadLocalEnv(join(directory, 'missing.env'), {}), false);
});

test('Local env loader rejects malformed, duplicate and prototype keys without partial application or secret output', async t => {
  const { directory } = await fixture(t);
  const envFile = join(directory, '.env');
  for (const bad of ['MALFORMED secret-value', '__proto__=secret-value', 'constructor=secret-value', 'prototype=secret-value', 'PORT=1\nPORT=secret-value', 'DATABASE_URL="secret-value']) {
    const environment = {};
    await writeFile(envFile, 'VALID=yes\n' + bad);
    await assert.rejects(loadLocalEnv(envFile, environment), error => !error.message.includes('secret-value'));
    assert.deepEqual(environment, {});
  }
});
