import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { developmentEnvironment, releaseSnapshot, deploy } from '../tools/pipeline.mjs';
import { initializeStaging } from '../tools/staging-init.mjs';
import { emptyStore } from '../tools/empty-store.mjs';
import { validateStore } from '../lib/storage.mjs';
import { OPERATIONAL_COLLECTIONS } from '../lib/operations.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SHA = 'a'.repeat(40);
const REMOTE = 'git@github.com:example/tss-tracker.git';
const STAGING_URL = 'postgresql://local:local@database:5432/tss_staging';
const databaseError = code => Object.assign(new Error(code), { code });

function gitFixture({ snapshots = [{}] } = {}) {
  const calls = [];
  let index = 0;
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'git');
    const snapshot = { branch: 'main', status: '', remote: REMOTE, sha: SHA, ...snapshots[Math.min(index, snapshots.length - 1)] };
    switch (args[0]) {
      case 'branch': return snapshot.branch;
      case 'status': return snapshot.status;
      case 'remote': return snapshot.remote;
      case 'rev-parse': index++; return snapshot.sha;
      case 'push': return '';
      default: assert.fail(`Unexpected git operation: ${args[0]}`);
    }
  };
  return { calls, execute, pushes: () => calls.filter(call => call.args[0] === 'push') };
}

test('development overrides production network and storage settings without changing the supplied environment', () => {
  const supplied = Object.freeze({
    ENV_FILE: '/production/.env', NODE_ENV: 'production', STORAGE_BACKEND: 'postgres',
    DATA_DIR: '/production/data', ATTACHMENTS_DIR: '/production/uploads',
    HOST: '0.0.0.0', PORT: '10000', ALLOWED_HOSTS: 'app.example.test',
    TLS_KEY_FILE: '/production/tls/key.pem', TLS_CERT_FILE: '/production/tls/cert.pem',
    PUBLIC_ORIGIN: 'https://app.example.test', TRUST_PROXY: '1',
    DATABASE_URL: 'postgresql://unused.invalid/production',
    TSS_TEST_DATABASE_URL: 'postgresql://unused.invalid/production', PATH: 'keep-this-path',
  });
  const before = { ...supplied };
  const actual = developmentEnvironment(supplied);
  assert.deepEqual(supplied, before);
  assert.notEqual(actual, supplied);
  assert.equal(actual.PATH, supplied.PATH);
  assert.equal(actual.NODE_ENV, 'development');
  assert.equal(actual.STORAGE_BACKEND, 'json');
  assert.equal(actual.DATA_DIR, join(ROOT, '.local', 'development'));
  assert.equal(actual.ATTACHMENTS_DIR, join(actual.DATA_DIR, 'attachments'));
  assert.equal(actual.HOST, '127.0.0.1');
  assert.equal(actual.PORT, '4318');
  assert.equal(actual.TRUST_PROXY, '0');
  for (const key of ['ENV_FILE', 'ALLOWED_HOSTS', 'TLS_KEY_FILE', 'TLS_CERT_FILE', 'PUBLIC_ORIGIN', 'DATABASE_URL', 'TSS_TEST_DATABASE_URL']) {
    assert.equal(actual[key], '', key);
  }
});

test('empty stores are valid, contain no samples or users, and do not share mutable state', () => {
  const store = emptyStore();
  const second = emptyStore();
  assert.equal(validateStore(store), store);
  assert.equal(store.schemaVersion, 2);
  assert.equal(store.nextNumber, 1);
  for (const key of ['users', 'customers', 'jobs', 'quotes', 'yard', 'workOrders', 'invoices', 'audit', ...OPERATIONAL_COLLECTIONS]) {
    assert.deepEqual(store[key], [], key);
    assert.notEqual(store[key], second[key]);
  }
  store.workflowConfiguration.rules.quoteAcceptedToJob = false;
  assert.equal(second.workflowConfiguration.rules.quoteAcceptedToJob, true);
});

test('staging initializes a valid empty store once and closes the repository', async () => {
  const calls = [];
  const result = await initializeStaging({ connectionString: STAGING_URL, bootstrap: '1', repositoryFactory: async options => {
    assert.deepEqual(options, { connectionString: STAGING_URL });
    return {
      async read() { calls.push('read'); throw databaseError('TSS_DATABASE_NOT_INITIALIZED'); },
      async initialize(store) { calls.push('initialize'); validateStore(store); assert.deepEqual(store, emptyStore()); },
      async close() { calls.push('close'); },
    };
  } });
  assert.equal(result, 'initialized');
  assert.deepEqual(calls, ['read', 'initialize', 'close']);
});

test('staging preserves an existing database without initializing it', async () => {
  const existing = { privateFixture: 'preserve-existing-records' };
  let closed = false;
  const result = await initializeStaging({ connectionString: STAGING_URL, bootstrap: '1', repositoryFactory: async () => ({
    async read() { return existing; },
    async initialize() { assert.fail('Existing data must not be initialized again.'); },
    async close() { closed = true; },
  }) });
  assert.equal(result, 'existing');
  assert.deepEqual(existing, { privateFixture: 'preserve-existing-records' });
  assert.equal(closed, true);
});

test('staging verifies the existing store when another initializer wins the race', async () => {
  const calls = [];
  let reads = 0;
  const result = await initializeStaging({ connectionString: STAGING_URL, bootstrap: '1', repositoryFactory: async () => ({
    async read() { calls.push('read'); if (!reads++) throw databaseError('TSS_DATABASE_NOT_INITIALIZED'); return emptyStore(); },
    async initialize() { calls.push('initialize'); throw databaseError('TSS_DATABASE_NOT_EMPTY'); },
    async close() { calls.push('close'); },
  }) });
  assert.equal(result, 'existing');
  assert.deepEqual(calls, ['read', 'initialize', 'read', 'close']);
});

test('staging propagates database failures and always closes repositories it opened', async t => {
  for (const stage of ['read', 'initialize', 'race-read']) {
    await t.test(stage, async () => {
      const failure = databaseError('TSS_POSTGRES_FAILURE');
      let reads = 0;
      let closed = false;
      await assert.rejects(initializeStaging({ connectionString: STAGING_URL, bootstrap: '1', repositoryFactory: async () => ({
        async read() {
          if (stage === 'read' || (stage === 'race-read' && reads++)) throw failure;
          throw databaseError('TSS_DATABASE_NOT_INITIALIZED');
        },
        async initialize() { throw stage === 'race-read' ? databaseError('TSS_DATABASE_NOT_EMPTY') : failure; },
        async close() { closed = true; },
      }) }), error => error === failure);
      assert.equal(closed, true);
    });
  }
});

test('staging rejects connections outside its isolated database before opening any repository', async t => {
  const invalid = [
    { connectionString: 'not-a-url', bootstrap: '1' },
    { connectionString: STAGING_URL, bootstrap: undefined },
    { connectionString: STAGING_URL, bootstrap: 'true' },
    { connectionString: 'https://database/tss_staging', bootstrap: '1' },
    { connectionString: 'postgresql://local:local@production.invalid/tss_staging', bootstrap: '1' },
    { connectionString: 'postgresql://local:local@database/production', bootstrap: '1' },
    { connectionString: `${STAGING_URL}?host=production.invalid&database=production`, bootstrap: '1' },
    { connectionString: `${STAGING_URL}#unexpected-configuration`, bootstrap: '1' },
  ];
  for (const [index, options] of invalid.entries()) {
    await t.test(`invalid configuration ${index + 1}`, async () => {
      let opened = false;
      await assert.rejects(initializeStaging({ ...options, repositoryFactory: async () => {
        opened = true;
        return { async read() {}, async close() {} };
      } }));
      assert.equal(opened, false);
    });
  }
});

test('release snapshots require clean main, a GitHub remote, and a complete commit hash', async t => {
  for (const [name, snapshot] of Object.entries({
    'feature branch': { branch: 'feature/work' },
    'detached HEAD': { branch: '' },
    'tracked edits': { status: ' M server.mjs' },
    'untracked files': { status: '?? release-notes.txt' },
    'non-GitHub remote': { remote: 'git@example.test:owner/repository.git' },
    'short hash': { sha: 'a'.repeat(12) },
    'incomplete SHA-256': { sha: 'a'.repeat(41) },
  })) {
    await t.test(name, async () => {
      const fixture = gitFixture({ snapshots: [snapshot] });
      await assert.rejects(releaseSnapshot(fixture.execute));
      assert.deepEqual(fixture.pushes(), []);
    });
  }
  for (const remote of [REMOTE, 'https://github.com/example/tss-tracker.git', 'ssh://git@github.com/example/tss-tracker.git']) {
    const fixture = gitFixture({ snapshots: [{ remote }] });
    assert.deepEqual(await releaseSnapshot(fixture.execute), { sha: SHA, remote });
  }
  const sha256 = 'b'.repeat(64);
  assert.equal((await releaseSnapshot(gitFixture({ snapshots: [{ sha: sha256 }] }).execute)).sha, sha256);
});

test('failed release checks never push', async () => {
  const fixture = gitFixture();
  const failure = new Error('The verification command failed.');
  let checks = 0;
  await assert.rejects(deploy({ execute: fixture.execute, check: async () => { checks++; throw failure; } }), error => error === failure);
  assert.equal(checks, 1);
  assert.deepEqual(fixture.pushes(), []);
});

test('invalid release preflight never starts checks or pushes', async t => {
  for (const snapshot of [{ branch: 'feature/work' }, { status: '?? uncommitted.txt' }, { remote: 'git@example.test:owner/repository.git' }]) {
    await t.test(Object.keys(snapshot)[0], async () => {
      const fixture = gitFixture({ snapshots: [snapshot] });
      let checks = 0;
      await assert.rejects(deploy({ execute: fixture.execute, check: async () => { checks++; } }));
      assert.equal(checks, 0);
      assert.deepEqual(fixture.pushes(), []);
    });
  }
});

test('release changes during verification prevent a push', async t => {
  for (const [name, after] of Object.entries({
    'commit changed': { sha: 'b'.repeat(40) },
    'destination changed': { remote: 'git@github.com:example/other.git' },
    'worktree changed': { status: ' M server.mjs' },
    'branch changed': { branch: 'feature/work' },
  })) {
    await t.test(name, async () => {
      const fixture = gitFixture({ snapshots: [{}, after] });
      let checks = 0;
      await assert.rejects(deploy({ execute: fixture.execute, check: async () => { checks++; } }));
      assert.equal(checks, 1);
      assert.deepEqual(fixture.pushes(), []);
    });
  }
});

test('successful deployment checks before pushing only the verified full SHA without force', async () => {
  const fixture = gitFixture();
  let checks = 0;
  await deploy({ execute: fixture.execute, check: async () => { checks++; assert.deepEqual(fixture.pushes(), []); } });
  assert.equal(checks, 1);
  const [push] = fixture.pushes();
  assert.equal(push.command, 'git');
  assert.equal(push.args[1], REMOTE);
  assert.equal(push.args[2], `${SHA}:refs/heads/main`);
  assert.equal(push.args.length, 3);
  assert.ok(fixture.calls.slice(0, -1).every(call => call.options?.capture === true));
});
