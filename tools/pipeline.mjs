import { spawn } from 'node:child_process';
import { mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { emptyStore } from './empty-store.mjs';
import { localDockerTarget, resolveDocker } from './docker.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMPOSE = ['compose', '--project-name', 'tss-local-staging', '--file', join(ROOT, 'compose.yaml')];
let dockerConnectionPromise;

export function developmentEnvironment(environment = process.env) {
  return {
    ...environment, ENV_FILE: '', NODE_ENV: 'development', STORAGE_BACKEND: 'json',
    DATA_DIR: join(ROOT, '.local', 'development'), ATTACHMENTS_DIR: join(ROOT, '.local', 'development', 'attachments'),
    HOST: '127.0.0.1', PORT: '4318', ALLOWED_HOSTS: '', TLS_KEY_FILE: '', TLS_CERT_FILE: '',
    PUBLIC_ORIGIN: '', TRUST_PROXY: '0', DATABASE_URL: '', TSS_TEST_DATABASE_URL: '',
  };
}

export function run(command, args, { environment = process.env, capture = false } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env: environment, shell: false, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let stdout = '';
    if (capture) { child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume(); }
    child.on('error', error => reject(new Error(error.code === 'ENOENT'
      ? `${command} is unavailable. Install it and reopen the terminal.` : `Could not start ${command}.`)));
    child.on('close', code => code === 0 ? resolveResult(stdout.trim()) : reject(new Error(`${command} failed (exit ${code ?? 'interrupted'}).`)));
  });
}

async function localTests() {
  const files = (await readdir(join(ROOT, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort().map(name => join('tests', name));
  await run(process.execPath, ['--test', ...files]);
}

async function development() {
  const environment = developmentEnvironment();
  const file = join(environment.DATA_DIR, 'jobs.json');
  await mkdir(dirname(file), { recursive: true });
  let handle;
  try { handle = await open(file, 'wx', 0o600); await handle.writeFile(JSON.stringify(emptyStore(), null, 2) + '\n'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  process.stdout.write('Development: http://127.0.0.1:4318 (isolated .local/development data).\n');
  await run(process.execPath, ['--watch', 'server.mjs'], { environment });
}

async function dockerConnection() {
  dockerConnectionPromise ??= (async () => {
    const installation = await resolveDocker();
    const options = { environment: installation.environment, capture: true };
    let context, details;
    try {
      context = await run(installation.command, ['context', 'show'], options);
      [details] = JSON.parse(await run(installation.command, ['context', 'inspect', context], options));
    } catch (cause) {
      throw new Error('Could not inspect the Docker context. Check Docker Desktop and your context settings. In Codex, approve Docker execution if the Windows sandbox blocks it.', { cause });
    }
    const target = localDockerTarget({ context, contextEndpoint: details?.Endpoints?.docker?.Host, environment: installation.environment });
    return { ...installation, ...target };
  })();
  return dockerConnectionPromise;
}

async function docker(args) {
  const connection = await dockerConnection();
  await run(connection.command, [...connection.args, ...COMPOSE, ...args], { environment: connection.environment });
}

async function dockerCheck() {
  const connection = await dockerConnection();
  process.stdout.write(`Docker CLI: ${connection.command}\nLocal context: ${connection.context}\nEndpoint: ${connection.endpoint}\n`);
  const options = { environment: connection.environment, capture: true };
  let versions;
  try {
    versions = JSON.parse(await run(connection.command, [...connection.args, 'version', '--format', '{{json .}}'], options));
  } catch (cause) {
    throw new Error('Cannot reach the local Docker engine. Start Docker Desktop with Linux containers. In Codex, approve engine access if the Windows sandbox blocks it.', { cause });
  }
  if (versions.Server?.Os !== 'linux') throw new Error('Staging requires a running Linux Docker engine. Start Docker Desktop and select Linux containers.');
  process.stdout.write(`Docker client ${versions.Client.Version}; Linux engine ${versions.Server.Version}\n`);
  await run(connection.command, [...connection.args, 'compose', 'version'], { environment: connection.environment });
  await docker(['config', '--quiet']);
  process.stdout.write('Local Docker and staging configuration are ready.\n');
}

async function stagingTest() {
  await docker(['run', '--rm', '--build', 'test']);
}

async function productionCheck() {
  await stagingTest();
  await stagingUp();
  await stagingSmoke();
}

async function stagingCertificate() {
  const certificate = join(ROOT, '.local', 'staging-root.crt');
  await mkdir(dirname(certificate), { recursive: true });
  await docker(['cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', certificate]);
  return certificate;
}

async function stagingUp() {
  await docker(['up', '--detach', '--build', '--wait', '--wait-timeout', '180', 'app', 'proxy']);
  process.stdout.write('Staging: https://localhost:8443. Export and trust the local certificate before browser use.\n');
}

async function stagingSmoke() {
  const certificate = await stagingCertificate();
  await run(process.execPath, ['tools/smoke.mjs', 'https://localhost:8443'], {
    environment: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
  });
}

function isGitHubDestination(remote) {
  if (typeof remote !== 'string' || /[\s?#]/.test(remote)) return false;
  const address = remote.startsWith('git@github.com:') ? `ssh://git@github.com/${remote.slice('git@github.com:'.length)}` : remote;
  try {
    const url = new URL(address);
    if (url.href !== address || url.hostname !== 'github.com' || url.port || url.password) return false;
    if (url.protocol === 'https:' ? Boolean(url.username) : url.protocol !== 'ssh:' || url.username !== 'git') return false;
    if (!/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) return false;
    const repository = url.pathname.split('/')[2].replace(/\.git$/, '');
    return Boolean(repository) && !['.', '..'].includes(repository);
  } catch { return false; }
}

export async function releaseSnapshot(execute = run, expectedBranch = 'main') {
  const branch = await execute('git', ['branch', '--show-current'], { capture: true });
  if (branch !== expectedBranch) throw new Error(`${expectedBranch === 'main' ? 'Production' : 'Staging'} release requires the ${expectedBranch} branch.`);
  const changes = await execute('git', ['status', '--porcelain'], { capture: true });
  if (changes) throw new Error('Commit all changes before requesting a release.');
  const remote = await execute('git', ['remote', 'get-url', '--push', 'origin'], { capture: true });
  if (!isGitHubDestination(remote)) {
    throw new Error('Release requires origin to point to your intended GitHub repository, without embedded credentials, query strings or extra path components.');
  }
  const sha = await execute('git', ['rev-parse', 'HEAD'], { capture: true });
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) throw new Error('Could not identify the release commit.');
  return { sha, remote };
}

async function pushVerifiedRelease({ execute, check, branch }) {
  const before = await releaseSnapshot(execute, branch);
  await check();
  const after = await releaseSnapshot(execute, branch);
  if (before.sha !== after.sha || before.remote !== after.remote) throw new Error('The release commit or destination changed during checks. Run the release again.');
  await execute('git', ['push', before.remote, `${before.sha}:refs/heads/${branch}`]);
}

export async function deploy({ execute = run, check = productionCheck } = {}) {
  await pushVerifiedRelease({ execute, check, branch: 'main' });
  process.stdout.write('Release pushed to GitHub. Render deployment proceeds after hosted CI passes; check Render for completion.\n');
}

export async function deployStaging({ execute = run, check = productionCheck } = {}) {
  await pushVerifiedRelease({ execute, check, branch: 'staging' });
  process.stdout.write('Verified staging commit pushed to the GitHub staging branch. Check GitHub Actions for hosted CI results.\n');
  process.stdout.write('This publishes code only, not development data or a hosted application. The production Render service is unchanged.\n');
}

export async function main([command, ...args] = process.argv.slice(2)) {
  switch (command) {
    case 'docker-check': return dockerCheck();
    case 'dev': return development();
    case 'dev-check': return localTests();
    case 'staging-up': return stagingUp();
    case 'staging-test': return stagingTest();
    case 'staging-check': return productionCheck();
    case 'staging-deploy': return deployStaging();
    case 'staging-smoke': return stagingSmoke();
    case 'staging-logs': return docker(['logs', '--follow', 'app', 'proxy']);
    case 'staging-down': return docker(['--profile', 'tools', 'down']);
    case 'staging-certificate':
      await stagingCertificate();
      process.stdout.write('Certificate exported to .local/staging-root.crt. Certificate trust is not changed automatically.\n');
      return;
    case 'production-check': return productionCheck();
    case 'production-deploy': return deploy();
    case 'production-import':
      if (args.length !== 1 || !process.env.TSS_PRODUCTION_DATABASE_URL) throw new Error('Set TSS_PRODUCTION_DATABASE_URL privately and supply exactly one source JSON path.');
      return run(process.execPath, ['tools/postgres-migrate.mjs', '--apply', '--source', resolve(ROOT, args[0])], {
        environment: { ...process.env, ENV_FILE: '', DATABASE_URL: process.env.TSS_PRODUCTION_DATABASE_URL },
      });
    case 'production-smoke': {
      const origin = args[0] ?? process.env.TSS_PRODUCTION_URL;
      if (!origin || args.length > 1 || new URL(origin).protocol !== 'https:') throw new Error('Supply the production HTTPS origin or set TSS_PRODUCTION_URL.');
      return run(process.execPath, ['tools/smoke.mjs', origin]);
    }
    default: throw new Error('Use the dev, staging:* or production:* scripts listed in package.json.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
