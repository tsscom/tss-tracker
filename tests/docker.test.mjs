import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDocker, localDockerTarget } from '../tools/docker.mjs';

const LOCAL = 'C:\\Users\\driver\\AppData\\Local';
const DESKTOP = `${LOCAL}\\Programs\\DockerDesktop\\resources\\bin\\docker.exe`;
const SYSTEM = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';
const PIPE = 'npipe:////./pipe/dockerDesktopLinuxEngine';

function executableFixture(files) {
  const checked = [];
  return {
    checked,
    async isExecutable(file) { checked.push(file); return files.includes(file); },
  };
}

test('explicit Docker executable takes priority and retains helper PATH without changing the environment', async () => {
  const override = 'D:\\Docker Tools\\docker.exe';
  const environment = Object.freeze({ TSS_DOCKER_EXE: override, PATH: 'C:\\tools', LOCALAPPDATA: LOCAL, KEEP: 'retained' });
  const before = { ...environment };
  const fixture = executableFixture([override, DESKTOP, 'C:\\tools\\docker.exe']);
  const resolved = await resolveDocker({ environment, platform: 'win32', isExecutable: fixture.isExecutable });
  assert.equal(resolved.command, override);
  assert.deepEqual(fixture.checked, [override]);
  assert.deepEqual(resolved.environment, { ...before, PATH: 'D:\\Docker Tools;C:\\tools' });
  assert.deepEqual(environment, before);
  assert.notEqual(resolved.environment, environment);
});

test('invalid explicit Docker executable fails without selecting another installation', async t => {
  for (const override of ['relative\\docker.exe', 'C:\\missing\\docker.exe']) {
    await t.test(override, async () => {
      const fixture = executableFixture([DESKTOP]);
      await assert.rejects(resolveDocker({
        environment: { TSS_DOCKER_EXE: override, LOCALAPPDATA: LOCAL },
        platform: 'win32', isExecutable: fixture.isExecutable,
      }), /TSS_DOCKER_EXE.*absolute path/);
      assert.ok(!fixture.checked.includes(DESKTOP));
    });
  }
});

test('Windows PATH Docker precedes a per-user installation and accepts quoted directories', async () => {
  const executable = 'D:\\Docker Tools\\docker.exe';
  const fixture = executableFixture([executable, DESKTOP]);
  const resolved = await resolveDocker({
    environment: { PATH: 'C:\\missing;"D:\\Docker Tools"', LOCALAPPDATA: LOCAL },
    platform: 'win32', isExecutable: fixture.isExecutable,
  });
  assert.equal(resolved.command, executable);
  assert.deepEqual(fixture.checked, ['C:\\missing\\docker.exe', executable]);
  assert.equal(resolved.environment.PATH, 'D:\\Docker Tools;C:\\missing;"D:\\Docker Tools"');
});

test('Windows Docker Desktop resolves its per-user installation before Program Files', async () => {
  const fixture = executableFixture([DESKTOP, SYSTEM]);
  const resolved = await resolveDocker({
    environment: { Path: 'C:\\missing', LocalAppData: LOCAL, ProgramFiles: 'C:\\Program Files' },
    platform: 'win32', isExecutable: fixture.isExecutable,
  });
  assert.equal(resolved.command, DESKTOP);
  assert.deepEqual(fixture.checked, ['C:\\missing\\docker.exe', DESKTOP]);
  assert.equal(resolved.environment.PATH, `${LOCAL}\\Programs\\DockerDesktop\\resources\\bin;C:\\missing`);
});

test('Windows Docker Desktop can fall back to Program Files', async () => {
  const fixture = executableFixture([SYSTEM]);
  const resolved = await resolveDocker({
    environment: { LOCALAPPDATA: LOCAL, ProgramFiles: 'C:\\Program Files' },
    platform: 'win32', isExecutable: fixture.isExecutable,
  });
  assert.equal(resolved.command, SYSTEM);
  assert.deepEqual(fixture.checked, [DESKTOP, SYSTEM]);
  assert.equal(resolved.environment.PATH, 'C:\\Program Files\\Docker\\Docker\\resources\\bin');
});

test('Windows child environment removes duplicate PATH keys and keeps its selected original value', async () => {
  const environment = Object.freeze({ Path: 'C:\\selected', PATH: 'C:\\duplicate', path: 'C:\\another', LOCALAPPDATA: LOCAL });
  const fixture = executableFixture([DESKTOP]);
  const resolved = await resolveDocker({ environment, platform: 'win32', isExecutable: fixture.isExecutable });
  assert.deepEqual(Object.keys(resolved.environment).filter(key => key.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(resolved.environment.PATH, `${LOCAL}\\Programs\\DockerDesktop\\resources\\bin;C:\\selected`);
  assert.equal(environment.PATH, 'C:\\duplicate');
  assert.equal(environment.Path, 'C:\\selected');
});

test('Docker discovery reports a missing executable and ignores relative PATH entries', async () => {
  const fixture = executableFixture(['relative\\docker.exe']);
  await assert.rejects(resolveDocker({
    environment: { PATH: 'relative', LOCALAPPDATA: LOCAL },
    platform: 'win32', isExecutable: fixture.isExecutable,
  }), /Docker CLI not found.*TSS_DOCKER_EXE/);
  assert.deepEqual(fixture.checked, [DESKTOP]);
});

test('Linux discovery uses executable Docker from PATH and preserves case-sensitive environment keys', async () => {
  const environment = Object.freeze({ PATH: '/missing:/usr/bin', Path: 'keep-case-sensitive', LOCALAPPDATA: LOCAL });
  const fixture = executableFixture(['/usr/bin/docker', DESKTOP]);
  const resolved = await resolveDocker({ environment, platform: 'linux', isExecutable: fixture.isExecutable });
  assert.equal(resolved.command, '/usr/bin/docker');
  assert.deepEqual(fixture.checked, ['/missing/docker', '/usr/bin/docker']);
  assert.equal(resolved.environment.PATH, '/usr/bin:/missing:/usr/bin');
  assert.equal(resolved.environment.Path, 'keep-case-sensitive');
  assert.equal(environment.PATH, '/missing:/usr/bin');
});

test('local contexts accept Docker Desktop pipes, Unix sockets and loopback TCP endpoints', async t => {
  for (const endpoint of [PIPE, 'unix:///var/run/docker.sock', 'tcp://localhost:2375', 'tcp://127.0.0.1:2376', 'tcp://[::1]:2375']) {
    await t.test(endpoint, () => {
      assert.deepEqual(localDockerTarget({ context: 'local-test', contextEndpoint: endpoint, environment: {} }), {
        args: ['--context', 'local-test'], endpoint, context: 'local-test',
      });
    });
  }
});

test('local Docker targeting rejects remote and ambiguous endpoints', async t => {
  for (const endpoint of [
    'tcp://docker.example.test:2376', 'ssh://localhost', 'npipe:////remote/pipe/docker_engine',
    'unix://remote/var/run/docker.sock', 'tcp://user@localhost:2375', 'tcp://localhost:2375?host=remote',
    'tcp://localhost:2375#remote', 'not-an-endpoint', undefined,
  ]) {
    await t.test(String(endpoint), () => {
      assert.throws(() => localDockerTarget({ context: 'remote-test', contextEndpoint: endpoint, environment: {} }), /local Docker endpoint/);
    });
  }
});

test('a local context must be identified before targeting it', () => {
  assert.throws(() => localDockerTarget({ contextEndpoint: PIPE, environment: {} }), /identify the local Docker context/);
});

test('DOCKER_HOST pins a local endpoint when no context override is present', () => {
  const environment = Object.freeze({ DOCKER_HOST: 'unix:///var/run/docker.sock' });
  assert.deepEqual(localDockerTarget({ context: 'unused', contextEndpoint: 'tcp://remote:2376', environment }), {
    args: ['--host', environment.DOCKER_HOST], endpoint: environment.DOCKER_HOST, context: '(DOCKER_HOST)',
  });
  assert.equal(environment.DOCKER_HOST, 'unix:///var/run/docker.sock');
  assert.throws(() => localDockerTarget({ context: 'desktop-linux', contextEndpoint: PIPE, environment: { DOCKER_HOST: 'tcp://remote:2376' } }), /local Docker endpoint/);
});

test('DOCKER_CONTEXT takes priority over DOCKER_HOST, including case-insensitive Windows keys', () => {
  const environment = Object.freeze({ Docker_Context: 'desktop-linux', Docker_Host: 'tcp://remote:2376' });
  assert.deepEqual(localDockerTarget({ context: 'desktop-linux', contextEndpoint: PIPE, environment, platform: 'win32' }), {
    args: ['--context', 'desktop-linux'], endpoint: PIPE, context: 'desktop-linux',
  });
  assert.throws(() => localDockerTarget({
    context: 'remote-test', contextEndpoint: 'tcp://remote:2376',
    environment: { DOCKER_CONTEXT: 'remote-test', DOCKER_HOST: 'unix:///var/run/docker.sock' },
  }), /local Docker endpoint/);
});
