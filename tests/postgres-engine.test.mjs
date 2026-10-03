import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createPostgresRepository } from '../lib/postgres-storage.mjs';
import { createTrackerServer } from '../server.mjs';
import { initialWorkflowConfiguration } from '../lib/workflows.mjs';
import { audit, saveCustomer, createQuote } from '../lib/business.mjs';
import { importFixture } from './helpers/postgres-fixture.mjs';

// PGlite executes actual PostgreSQL SQL, but exposes one session. This adapter
// serializes access to that session. It does not simulate separate database
// connections, network failures, or advisory-lock contention between sessions.
function singleSessionPool(engine) {
  let pending = Promise.resolve();
  const statements = [];
  return {
    statements,
    async connect() {
      const previous = pending;
      let unlock;
      pending = new Promise(resolve => { unlock = resolve; });
      await previous;
      let released = false;
      return {
        async query(sql, parameters) {
          statements.push(sql);
          if (parameters?.length) return engine.query(sql, parameters);
          const results = await engine.exec(sql);
          return results.at(-1) ?? { rows: [] };
        },
        release() { if (!released) { released = true; unlock(); } },
      };
    },
  };
}

function emptyStore() {
  return {
    schemaVersion: 2, nextNumber: 1, counters: { quotes: 1, workOrders: 1, invoices: 1 },
    users: [], customers: [], jobs: [], quotes: [], yard: [], workOrders: [], invoices: [], audit: [],
    workflowConfiguration: initialWorkflowConfiguration(),
  };
}

test('Connection-cleanup unit test discards a failed client and hides driver credentials without closing a caller-owned pool', async () => {
  // This small fault-injection test covers adapter cleanup, not SQL or actual
  // network behavior. Real SQL behavior is exercised by the engine test below.
  const privateDriverMessage = 'postgresql://fake-user:fixture-secret@invalid.example/test';
  const queries = [];
  let releaseError, poolEnded = false;
  const pool = {
    async connect() {
      return {
        async query(sql) { queries.push(sql); throw new Error(privateDriverMessage); },
        release(error) { releaseError = error; },
      };
    },
    async end() { poolEnded = true; },
  };
  const repository = await createPostgresRepository({ pool, migrate: false });
  await assert.rejects(repository.read(), error => error.code === 'TSS_POSTGRES_FAILURE' && !error.message.includes('fixture-secret') && !error.message.includes('invalid.example'));
  assert.deepEqual(queries, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  assert.ok(releaseError instanceof Error);
  assert.ok(!releaseError.message.includes('fixture-secret'));
  await repository.close();
  assert.equal(poolEnded, false);
});

test('Embedded PostgreSQL verifies actual migrations, JSONB persistence and transaction constraints in one session', async t => {
  const engine = new PGlite();
  const repositories = [], servers = [];
  t.after(async () => {
    for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    await Promise.all(repositories.map(repository => repository.close()));
    await engine.close();
  });
  await engine.waitReady;
  const pool = singleSessionPool(engine);
  const repository = await createPostgresRepository({ pool });
  repositories.push(repository);

  await t.test('Migration creates the entity tables and is repeatable without changing its installed checksum', async () => {
    const tables = await engine.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'tss' ORDER BY table_name");
    assert.deepEqual(tables.rows.map(row => row.table_name), ['activities', 'attachments', 'audit', 'costs', 'customers', 'drivers', 'incidents', 'invoices', 'jobs', 'metadata', 'mobile_operations', 'opportunities', 'quotes', 'schema_migrations', 'users', 'vehicles', 'work_orders', 'yard']);
    const before = await engine.query('SELECT version, checksum FROM tss.schema_migrations ORDER BY version');
    assert.deepEqual(before.rows, [
      { version: 1, checksum: '0ed53f2dbaacf0e5066767b125612185969db3f247617310b02a41767ed68844' },
      { version: 2, checksum: '851b14eb1c7f422ddb724a0740961527831e395764c23737ef68f0923ebb4ee3' },
    ]);
    await repository.applyMigrations();
    assert.deepEqual((await engine.query('SELECT version, checksum FROM tss.schema_migrations ORDER BY version')).rows, before.rows);
  });

  await t.test('Import preserves all eight collections, cyclic quote/job links, credentials, payment order and extra metadata', async () => {
    const original = importFixture(), untouched = structuredClone(original);
    await assert.rejects(repository.read(), error => error.code === 'TSS_DATABASE_NOT_INITIALIZED');
    await repository.initialize(original);
    assert.deepEqual(original, untouched);
    assert.deepEqual(await repository.read(), untouched);
    const relationship = await engine.query('SELECT j.quote_id, q.job_id FROM tss.jobs j JOIN tss.quotes q ON q.id = j.quote_id');
    assert.deepEqual(relationship.rows, [{ quote_id: untouched.jobs[0].quoteId, job_id: untouched.jobs[0].id }]);
    const jsonb = await engine.query('SELECT jsonb_typeof(payload) AS kind FROM tss.users');
    assert.equal(jsonb.rows[0].kind, 'object');
    await assert.rejects(repository.initialize(importFixture()), error => error.code === 'TSS_DATABASE_NOT_EMPTY');
    assert.deepEqual(await repository.read(), untouched);
  });

  await t.test('A business change writes only the changed customer and appended audit row; a no-op writes no data', async () => {
    let start = pool.statements.length;
    const result = await repository.mutate(next => saveCustomer(next, next.users[0], { name: 'Cliente alterado apenas nesta transação' }));
    const changedTables = pool.statements.slice(start).filter(sql => /^INSERT INTO tss\./.test(sql)).map(sql => sql.match(/^INSERT INTO tss\.([a-z_]+)/)[1]);
    assert.deepEqual(changedTables, ['customers', 'audit']);
    assert.ok((await repository.read()).customers.some(customer => customer.id === result.customer.id));
    start = pool.statements.length;
    await repository.mutate(() => 'no-op');
    assert.equal(pool.statements.slice(start).filter(sql => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql)).length, 0);
  });

  await t.test('A unique quotation reference violation rolls back the customer, quotation counter and audit together', async () => {
    const before = await repository.read();
    await assert.rejects(repository.mutate(next => {
      saveCustomer(next, next.users[0], { name: 'Cliente a reverter' });
      const { quote } = createQuote(next, next.users[0], { customerId: next.customers[0].id, pickup: 'Alenquer', delivery: 'Faro', pickupDate: '2026-10-15', deliveryDate: '2026-10-16', quotedPrice: '250,00' });
      quote.reference = next.quotes[0].reference;
    }), error => error.code === '23505');
    assert.deepEqual(await repository.read(), before);
  });

  await t.test('A deferred customer foreign key rejects COMMIT and rolls back the job and audit', async () => {
    const before = await repository.read();
    await assert.rejects(repository.mutate(next => {
      next.jobs[0].customerId = randomUUID();
      audit(next, next.users[0], 'test.invalidCustomerReference', 'job', next.jobs[0].id);
    }), error => error.code === '23503');
    assert.deepEqual(await repository.read(), before);
  });

  await t.test('Active yard locations are unique even when their letter case differs', async () => {
    const before = await repository.read();
    await assert.rejects(repository.mutate(next => {
      next.yard.push({ ...structuredClone(next.yard[0]), id: randomUUID(), vehicle: 'IMPORT-OTHER', location: next.yard[0].location.toUpperCase() });
      audit(next, next.users[0], 'test.invalidYardLocation', 'yard', next.yard.at(-1).id);
    }), error => error.code === '23505');
    assert.deepEqual(await repository.read(), before);
  });

  await t.test('A job can have only one invoice and stored JSONB IDs must match their row IDs', async () => {
    const before = await repository.read();
    await assert.rejects(repository.mutate(next => {
      next.invoices.push({ ...structuredClone(next.invoices[0]), id: randomUUID(), reference: 'INT-0099' });
    }), error => error.code === '23505');
    await assert.rejects(engine.query("UPDATE tss.customers SET payload = jsonb_set(payload, '{id}', to_jsonb($1::text)) WHERE id = $2", [randomUUID(), before.customers[0].id]), error => error.code === '23514');
    assert.deepEqual(await repository.read(), before);
  });

  await t.test('A thrown business callback leaves the transaction unchanged and preserves the original error', async () => {
    const before = await repository.read(), failure = new Error('Intentional business callback failure.');
    await assert.rejects(repository.mutate(next => {
      saveCustomer(next, next.users[0], { name: 'Cliente de teste sem persistência' });
      throw failure;
    }), error => error === failure);
    assert.deepEqual(await repository.read(), before);
  });

  await t.test('The HTTP server supports owner setup, authenticated customer creation and protected reads through PostgreSQL', async () => {
    const schema = `tss_test_${randomUUID().replaceAll('-', '')}`;
    const apiRepository = await createPostgresRepository({ pool, schema });
    repositories.push(apiRepository);
    await apiRepository.initialize(emptyStore());
    const server = await createTrackerServer({ repository: apiRepository });
    servers.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '', csrf = '';
    async function call(path, method = 'GET', body, authenticated = true) {
      const response = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(authenticated && csrf ? { 'X-CSRF-Token': csrf } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const result = await response.json();
      if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
      if (result.csrfToken) csrf = result.csrfToken;
      return { status: response.status, body: result };
    }
    assert.equal((await call('/api/session')).body.setupRequired, true);
    const password = 'A unique local PostgreSQL API test password 2026';
    const setup = await call('/api/setup', 'POST', { name: 'Gerente fictício', username: 'engine.owner', password });
    assert.equal(setup.status, 201, JSON.stringify(setup.body));
    assert.equal(setup.body.user.role, 'gerente');
    const created = await call('/api/customers', 'POST', { name: 'Cliente fictício através da API', email: 'api@example.test' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const visible = await call('/api/workspace');
    assert.equal(visible.status, 200);
    assert.equal(visible.body.customers.length, 1);
    assert.ok(!JSON.stringify(visible.body).includes(password));
    assert.equal((await call('/api/workspace', 'GET', undefined, false)).status, 401);
    const saved = await apiRepository.read();
    assert.equal(saved.customers[0].id, created.body.customer.id);
    assert.equal(saved.users[0].password.algorithm, 'scrypt');
    assert.ok(saved.audit.some(event => event.event === 'security.setup'));
    assert.ok(saved.audit.some(event => event.event === 'customer.create'));
    await new Promise(resolve => server.close(resolve));
  });
});
