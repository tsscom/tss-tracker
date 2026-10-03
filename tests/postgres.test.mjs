import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createPostgresRepository } from '../lib/postgres-storage.mjs';
import { prepareStoreForMigration } from '../lib/storage.mjs';
import { audit, saveCustomer, createQuote } from '../lib/business.mjs';
import { importFixture } from './helpers/postgres-fixture.mjs';

// Only an explicitly configured test connection enables SQL execution. Every
// case owns a fresh restricted schema; the application's tss schema is untouched.
const DATABASE_URL = process.env.TSS_TEST_DATABASE_URL;
const LIVE = { skip: DATABASE_URL ? false : 'Configure TSS_TEST_DATABASE_URL to run isolated live PostgreSQL tests.' };

async function isolatedDatabase(t) {
  const { Pool } = await import('pg');
  const schema = `tss_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^tss_test_[a-f0-9]{32}$/);
  const cleanupPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  const repositories = [];
  t.after(async () => {
    await Promise.all(repositories.map(repository => repository.close()));
    try {
      // The identifier consists exclusively of the validated generated prefix
      // and UUID. No configured or application schema may be dropped here.
      await cleanupPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally { await cleanupPool.end(); }
  });
  async function open() {
    const repository = await createPostgresRepository({ connectionString: DATABASE_URL, schema });
    repositories.push(repository);
    return repository;
  }
  return { repository: await open(), open };
}

test('PostgreSQL repository rejects unsafe and non-test schema identifiers before connecting', async () => {
  for (const schema of ['public', 'tss_other', 'tss_test_abc', 'tss; DROP SCHEMA public CASCADE', 'tss_test_' + 'A'.repeat(32), 'tss_test_' + 'a'.repeat(32) + '"']) {
    await assert.rejects(createPostgresRepository({ connectionString: 'postgresql://unused.invalid/test', schema }), /schema|esquema/i);
  }
});

test('Import preparation validates a real workflow snapshot without changing credentials, IDs or metadata', () => {
  const original = importFixture(), untouched = structuredClone(original);
  assert.deepEqual(prepareStoreForMigration(original), untouched);
  assert.deepEqual(original, untouched);
  assert.equal(original.invoices[0].payments.length, 2);
  assert.equal(original.jobs[0].paymentStatus, 'Parcial');
});

test('Import preparation rejects malformed credentials, duplicate IDs and invalid counters without rewriting the source', () => {
  for (const corrupt of [
    store => { store.users[0].password.N = 1; },
    store => { store.users.push(structuredClone(store.users[0])); },
    store => { store.counters.quotes = 0; },
    store => { store.workflowConfiguration.rules.quoteAcceptedToJob = 'true'; },
  ]) {
    const source = importFixture();
    corrupt(source);
    const before = structuredClone(source);
    assert.throws(() => prepareStoreForMigration(source));
    assert.deepEqual(source, before);
  }
});

test('PostgreSQL import preserves credentials, every collection, ordering, IDs and metadata; reimport is refused', LIVE, async t => {
  const { repository, open } = await isolatedDatabase(t);
  await assert.rejects(repository.read(), error => error.code === 'TSS_DATABASE_NOT_INITIALIZED');
  const original = importFixture(), untouched = structuredClone(original);
  await repository.initialize(original);
  assert.deepEqual(original, untouched, 'Initialization must not rewrite the caller or source snapshot.');
  assert.deepEqual(await repository.read(), untouched);
  const second = await open();
  assert.deepEqual(await second.read(), untouched, 'A second repository must read committed records.');
  const replacement = importFixture();
  await assert.rejects(second.initialize(replacement));
  assert.deepEqual(await repository.read(), untouched, 'Refused reimport must preserve the first import.');
});

test('PostgreSQL rolls back mutated records, counters and audit when the callback fails', LIVE, async t => {
  const { repository, open } = await isolatedDatabase(t);
  await repository.initialize(importFixture());
  const before = await repository.read(), second = await open();
  const failure = new Error('Intentional callback failure after record and audit mutations.');
  await assert.rejects(repository.mutate(async next => {
    const actor = next.users[0];
    saveCustomer(next, actor, { name: 'Cliente que não pode persistir' });
    createQuote(next, actor, { customerId: next.customers[0].id, pickup: 'Alenquer', delivery: 'Faro', pickupDate: '2026-10-15', deliveryDate: '2026-10-16', quotedPrice: '250,00' });
    await delay(1);
    throw failure;
  }), error => error === failure);
  assert.deepEqual(await repository.read(), before);
  assert.deepEqual(await second.read(), before);
});

test('PostgreSQL rolls back the entire transaction when persistence violates a unique quotation reference constraint', LIVE, async t => {
  const { repository, open } = await isolatedDatabase(t);
  await repository.initialize(importFixture());
  const before = await repository.read(), second = await open();
  await assert.rejects(repository.mutate(next => {
    const actor = next.users[0];
    saveCustomer(next, actor, { name: 'Cliente associado à transação rejeitada' });
    const { quote } = createQuote(next, actor, { customerId: next.customers[0].id, pickup: 'Alenquer', delivery: 'Faro', pickupDate: '2026-10-15', deliveryDate: '2026-10-16', quotedPrice: '250,00' });
    quote.reference = next.quotes[0].reference;
    audit(next, actor, 'test.invalidDuplicateReference', 'quote', quote.id);
  }), error => error.code === '23505');
  assert.deepEqual(await repository.read(), before, 'A rejected write must not publish partial state.');
  assert.deepEqual(await second.read(), before, 'Other connections must observe the same rollback.');
});

test('Two independent PostgreSQL repositories use fresh state and preserve concurrent quotations, references and audit', LIVE, async t => {
  const { repository, open } = await isolatedDatabase(t);
  const original = importFixture();
  await repository.initialize(original);
  const second = await open();
  await second.read();
  const created = await repository.mutate(next => saveCustomer(next, next.users[0], { name: 'Visível na segunda ligação' }));
  assert.ok((await second.read()).customers.some(value => value.id === created.customer.id));
  const customerId = original.customers[0].id;
  const count = 12;
  const quotations = await Promise.all(Array.from({ length: count }, (_, index) => (index % 2 ? second : repository).mutate(async next => {
    // A short async step exercises transaction locking across pools, rather than
    // relying on a process-local promise queue or immediately synchronous writes.
    await delay(1);
    return createQuote(next, next.users[0], { customerId, pickup: `Alenquer ${index}`, delivery: 'Porto', pickupDate: '2026-10-20', deliveryDate: '2026-10-21', quotedPrice: '350,00' });
  })));
  const final = await repository.read();
  assert.deepEqual(await second.read(), final);
  assert.equal(final.quotes.length, original.quotes.length + count);
  assert.equal(final.counters.quotes, original.counters.quotes + count);
  assert.equal(new Set(final.quotes.map(value => value.reference)).size, final.quotes.length);
  assert.equal(new Set(quotations.map(value => value.quote.id)).size, count);
  for (const { quote } of quotations) assert.ok(final.quotes.some(value => value.id === quote.id));
  assert.equal(final.audit.filter(value => value.event === 'quote.create').length, original.audit.filter(value => value.event === 'quote.create').length + count);
});
