import test from 'node:test';
import assert from 'node:assert/strict';
import { deploy, deployStaging, releaseSnapshot } from '../tools/pipeline.mjs';

const SHA = 'a'.repeat(40);
const REMOTE = 'git@github.com:example/tss-tracker.git';

function gitFixture({ snapshots = [{}] } = {}) {
  const calls = [];
  let index = 0;
  const execute = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, 'git');
    const snapshot = { branch: 'staging', status: '', remote: REMOTE, sha: SHA, ...snapshots[Math.min(index, snapshots.length - 1)] };
    switch (args[0]) {
      case 'branch': return snapshot.branch;
      case 'status': return snapshot.status;
      case 'remote':
        if (snapshot.remoteError) throw snapshot.remoteError;
        return snapshot.remote;
      case 'rev-parse':
        if (snapshot.shaError) throw snapshot.shaError;
        index++;
        return snapshot.sha;
      case 'push': return '';
      default: assert.fail(`Unexpected git operation: ${args[0]}`);
    }
  };
  return { calls, execute, pushes: () => calls.filter(call => call.args[0] === 'push') };
}

test('staging deployment verifies before pushing only the full SHA to staging without force', async () => {
  const fixture = gitFixture();
  let checks = 0;
  await deployStaging({ execute: fixture.execute, check: async () => {
    checks++;
    assert.deepEqual(fixture.pushes(), []);
    assert.equal(fixture.calls.at(-1).args[0], 'rev-parse');
  } });
  assert.equal(checks, 1);
  assert.deepEqual(fixture.pushes().map(call => call.args), [['push', REMOTE, `${SHA}:refs/heads/staging`]]);
  assert.equal(fixture.calls.filter(call => call.args[0] === 'rev-parse').length, 2);
  assert.ok(fixture.calls.slice(0, -1).every(call => call.options?.capture === true));
});

test('staging accepts supported GitHub transports and complete SHA-256 hashes', async t => {
  for (const remote of [REMOTE, 'https://github.com/example/tss-tracker.git', 'ssh://git@github.com/example/tss-tracker.git']) {
    await t.test(remote, async () => {
      const sha = 'b'.repeat(64);
      const fixture = gitFixture({ snapshots: [{ remote, sha }] });
      await deployStaging({ execute: fixture.execute, check: async () => {} });
      assert.deepEqual(fixture.pushes().map(call => call.args), [['push', remote, `${sha}:refs/heads/staging`]]);
    });
  }
});

test('staging preflight rejects invalid source state without checks or pushes', async t => {
  const cases = {
    'main branch': { branch: 'main' },
    'feature branch': { branch: 'feature/work' },
    'detached HEAD': { branch: '' },
    'unborn staging branch': { shaError: new Error('HEAD does not exist.') },
    'tracked edits': { status: ' M server.mjs' },
    'staged edits': { status: 'M  server.mjs' },
    'untracked files': { status: '?? release-notes.txt' },
    'short SHA': { sha: 'a'.repeat(12) },
    'incomplete SHA-256': { sha: 'a'.repeat(41) },
    'invalid full SHA': { sha: 'z'.repeat(40) },
    'missing origin': { remoteError: new Error('No such remote: origin.') },
  };
  for (const [name, snapshot] of Object.entries(cases)) {
    await t.test(name, async () => {
      const fixture = gitFixture({ snapshots: [snapshot] });
      let checks = 0;
      await assert.rejects(deployStaging({ execute: fixture.execute, check: async () => { checks++; } }));
      assert.equal(checks, 0);
      assert.deepEqual(fixture.pushes(), []);
    });
  }
});

test('staging rejects non-GitHub, credential-bearing and malformed destinations before verification', async t => {
  const remotes = {
    'non-GitHub SSH': 'git@example.test:owner/repository.git',
    'non-GitHub HTTPS': 'https://gitlab.com/owner/repository.git',
    'GitHub-like hostname': 'https://github.com.example.test/owner/repository.git',
    'HTTP transport': 'http://github.com/owner/repository.git',
    'HTTPS username': 'https://secret-token@github.com/owner/repository.git',
    'HTTPS password': 'https://owner:secret-token@github.com/owner/repository.git',
    'SSH password': 'ssh://git:secret-token@github.com/owner/repository.git',
    'unexpected SSH user': 'ssh://owner@github.com/owner/repository.git',
    'explicit port': 'ssh://git@github.com:22/owner/repository.git',
    'query string': 'https://github.com/owner/repository.git?token=secret-token',
    'fragment': 'https://github.com/owner/repository.git#main',
    'extra path component': 'https://github.com/owner/repository.git/extra',
    'trailing slash': 'https://github.com/owner/repository.git/',
    'missing repository': 'https://github.com/owner',
    'empty repository': 'https://github.com/owner/.git',
    'normalized traversal': 'https://github.com/owner/../repository.git',
    'encoded path separator': 'https://github.com/owner/repository%2fextra.git',
    'whitespace': 'https://github.com/owner/repository.git unexpected',
    'local path': 'C:/repositories/tss-tracker.git',
    'option-like destination': '--receive-pack=unexpected',
  };
  for (const [name, remote] of Object.entries(remotes)) {
    await t.test(name, async () => {
      const fixture = gitFixture({ snapshots: [{ remote }] });
      let checks = 0;
      await assert.rejects(deployStaging({ execute: fixture.execute, check: async () => { checks++; } }), error => {
        assert.ok(!error.message.includes('secret-token'));
        return true;
      });
      assert.equal(checks, 0);
      assert.deepEqual(fixture.pushes(), []);
    });
  }
});

test('failed staging verification never pushes', async () => {
  const fixture = gitFixture();
  const failure = new Error('Container tests failed.');
  let checks = 0;
  await assert.rejects(deployStaging({ execute: fixture.execute, check: async () => { checks++; throw failure; } }), error => error === failure);
  assert.equal(checks, 1);
  assert.equal(fixture.calls.filter(call => call.args[0] === 'rev-parse').length, 1);
  assert.deepEqual(fixture.pushes(), []);
});

test('changes during staging verification prevent publication', async t => {
  const cases = {
    'commit changed': { sha: 'b'.repeat(40) },
    'destination changed': { remote: 'git@github.com:example/other.git' },
    'worktree changed': { status: ' M server.mjs' },
    'branch changed': { branch: 'main' },
    'origin removed': { remoteError: new Error('No such remote: origin.') },
    'HEAD unavailable': { shaError: new Error('HEAD does not exist.') },
  };
  for (const [name, after] of Object.entries(cases)) {
    await t.test(name, async () => {
      const fixture = gitFixture({ snapshots: [{}, after] });
      let checks = 0;
      await assert.rejects(deployStaging({ execute: fixture.execute, check: async () => { checks++; } }));
      assert.equal(checks, 1);
      assert.deepEqual(fixture.pushes(), []);
    });
  }
});

test('production retains clean main requirement and only publishes to main', async () => {
  const staging = gitFixture();
  let invalidChecks = 0;
  await assert.rejects(deploy({ execute: staging.execute, check: async () => { invalidChecks++; } }), /main branch/);
  assert.equal(invalidChecks, 0);
  assert.deepEqual(staging.pushes(), []);

  const production = gitFixture({ snapshots: [{ branch: 'main' }] });
  assert.deepEqual(await releaseSnapshot(production.execute), { sha: SHA, remote: REMOTE });
  let checks = 0;
  await deploy({ execute: production.execute, check: async () => { checks++; } });
  assert.equal(checks, 1);
  assert.deepEqual(production.pushes().map(call => call.args), [['push', REMOTE, `${SHA}:refs/heads/main`]]);
});
