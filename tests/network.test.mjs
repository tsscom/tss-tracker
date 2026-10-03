import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, readdir, unlink, rmdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrackerServer } from '../server.mjs';
import { validateNetworkOptions, requestAuthority } from '../lib/network.mjs';

async function httpFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tss-network-test-'));
  const server = await createTrackerServer({ dataFile: join(dir, 'jobs.json'), ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => server.close(done)); for (const name of await readdir(dir)) await unlink(join(dir, name)); await rmdir(dir); });
  function call(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { Host: `127.0.0.1:${server.address().port}`, 'X-TSS-Request': '1', 'Content-Type': 'application/json', ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on('error', reject); if (body) request.write(JSON.stringify(body)); request.end();
    });
  }
  return { call, server };
}

test('Proxy mode requires an HTTPS origin and explicit trust; local defaults ignore forwarded headers', () => {
  const options = validateNetworkOptions();
  assert.deepEqual(requestAuthority({ socket: {}, headers: { host: 'localhost:4317', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.test' } }, 4317, options), {
    secure: false, host: 'localhost:4317', scheme: 'http', origin: 'http://localhost:4317', allowedHosts: ['127.0.0.1:4317', 'localhost:4317', '[::1]:4317'],
  });
  assert.throws(() => validateNetworkOptions({ publicOrigin: 'https://tss.test' }), /TRUST_PROXY/);
  assert.throws(() => validateNetworkOptions({ trustProxy: true }), /PUBLIC_ORIGIN/);
  for (const publicOrigin of ['not a URL', 'http://tss.test', 'https://tss.test/app', 'https://tss.test/?secret=1', 'https://tss.test/#fragment', 'https://user:secret@tss.test']) assert.throws(() => validateNetworkOptions({ publicOrigin, trustProxy: true }), /PUBLIC_ORIGIN/);
  assert.throws(() => validateNetworkOptions({ publicOrigin: 'https://tss.test', trustProxy: true, tls: {} }), /TLS/);
  assert.throws(() => validateNetworkOptions({ publicOrigin: 'https://tss.test', trustProxy: true, allowedHosts: ['extra.test:443'] }), /ALLOWED_HOSTS/);
  assert.equal(validateNetworkOptions({ publicOrigin: 'https://TSS.test:443/', trustProxy: true }).publicOrigin, 'https://tss.test');
});

test('HTTPS proxy validates the canonical host and protocol, protects writes and sets secure cookies', async t => {
  const { call } = await httpFixture(t, { network: { publicOrigin: 'https://tss.test:443', trustProxy: true }, loginMaxAttempts: 1 });
  const headers = { Host: 'tss.test', 'X-Forwarded-Proto': 'https' };
  const invoke = (path, options = {}) => call(path, { ...options, headers: { ...headers, ...options.headers } });
  assert.equal((await invoke('/api/session')).status, 200);
  assert.equal((await invoke('/api/session', { headers: { Host: 'tss.test:443' } })).status, 200);
  for (const protocol of ['', 'http', 'HTTPS', 'https, http', 'https, https']) assert.equal((await invoke('/api/session', { headers: { 'X-Forwarded-Proto': protocol } })).status, 403);
  for (const Host of ['127.0.0.1:4317', 'evil.test', 'evil.test@tss.test', 'tss.test/path']) assert.equal((await invoke('/api/session', { headers: { Host, 'X-Forwarded-Host': 'tss.test' } })).status, 403);
  assert.equal((await invoke('/api/session', { headers: { 'X-Forwarded-Host': 'evil.test' } })).status, 200);
  const setupBody = { name: 'Proxy Test', username: 'proxy', password: 'A unique proxy test passphrase' };
  for (const Origin of ['http://tss.test', 'https://evil.test', 'https://tss.test:443']) assert.equal((await invoke('/api/setup', { method: 'POST', body: setupBody, headers: { Origin } })).status, 403);
  const setup = await invoke('/api/setup', { method: 'POST', body: setupBody, headers: { Origin: 'https://tss.test' } });
  assert.equal(setup.status, 201); assert.match(setup.headers['set-cookie'][0], /; Secure/);
  const authenticated = { Cookie: setup.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': setup.body.csrfToken, Origin: 'https://tss.test' };
  assert.equal((await invoke('/api/customers', { method: 'POST', body: { name: 'Proxy customer' }, headers: authenticated })).status, 201);
  const mobile = await invoke('/api/mobile/workspace', { headers: authenticated });
  assert.deepEqual(mobile.body.network, { secure: true, localOnly: false });
  const logout = await invoke('/api/logout', { method: 'POST', body: {}, headers: authenticated });
  assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Max-Age=0; Secure/);
  const wrongLogin = { username: 'proxy', password: 'wrong password' };
  assert.equal((await invoke('/api/login', { method: 'POST', body: wrongLogin, headers: { 'X-Forwarded-For': '192.0.2.1' } })).status, 401);
  assert.equal((await invoke('/api/login', { method: 'POST', body: wrongLogin, headers: { 'X-Forwarded-For': '192.0.2.2' } })).status, 429);
});

test('Loopback HTTP keeps plain cookies and requires its local origin', async t => {
  const { call, server } = await httpFixture(t);
  const localOrigin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await call('/api/session', { headers: { Host: 'public.test', 'X-Forwarded-Proto': 'https' } })).status, 403);
  const setupBody = { name: 'Local Test', username: 'local', password: 'A unique local test passphrase' };
  assert.equal((await call('/api/setup', { method: 'POST', body: setupBody, headers: { Origin: 'https://public.test', 'X-Forwarded-Proto': 'https' } })).status, 403);
  const setup = await call('/api/setup', { method: 'POST', body: setupBody, headers: { Origin: localOrigin, 'X-Forwarded-Proto': 'https' } });
  assert.equal(setup.status, 201); assert.doesNotMatch(setup.headers['set-cookie'][0], /; Secure/);
});

test('Only GET health probes bypass host checks, read storage and omit failure details', async t => {
  let unavailable = false, reads = 0;
  const repository = { async read() { reads++; if (unavailable) throw new Error('private database connection details'); return { users: [] }; }, async close() {} };
  const { call } = await httpFixture(t, { repository, network: { publicOrigin: 'https://tss.test', trustProxy: true } });
  const probe = await call('/healthz', { headers: { Host: 'private-render-address:10000' } });
  assert.equal(probe.status, 200); assert.deepEqual(probe.body, { status: 'ok' }); assert.equal(reads, 2);
  assert.equal((await call('/api/session', { headers: { Host: 'private-render-address:10000' } })).status, 403);
  assert.equal((await call('/healthz', { method: 'POST', headers: { Host: 'private-render-address:10000' } })).status, 403);
  assert.equal((await call('/healthz', { method: 'POST', headers: { Host: 'tss.test', 'X-Forwarded-Proto': 'https' } })).status, 404);
  unavailable = true;
  const failure = await call('/healthz');
  assert.equal(failure.status, 503); assert.deepEqual(failure.body, { status: 'unavailable' }); assert.equal(reads, 3);
});

test('Startup uses a selected environment file or disables .env and keeps generated data isolated', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tss-startup-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise(done => { child.once('close', done); child.kill(); });
    assert.equal(resolve(join(dir, '..')), resolve(tmpdir())); assert.ok(basename(dir).startsWith('tss-startup-test-'));
    await rm(dir, { recursive: true, force: true });
  });
  async function start(overrides, content) {
    const reservation = http.createServer();
    await new Promise(done => reservation.listen(0, '127.0.0.1', done));
    const port = reservation.address().port;
    await new Promise(done => reservation.close(done));
    const environment = { ...process.env };
    for (const name of ['PORT', 'HOST', 'STORAGE_BACKEND', 'DATABASE_URL', 'TLS_KEY_FILE', 'TLS_CERT_FILE', 'ALLOWED_HOSTS', 'PUBLIC_ORIGIN', 'TRUST_PROXY', 'ENV_FILE', 'DATA_DIR', 'ATTACHMENTS_DIR']) delete environment[name];
    const dataDir = join(dir, content ? 'selected-state' : 'disabled-state');
    if (content) {
      const envFile = join(dir, 'selected.env');
      await writeFile(envFile, `PORT=${port}\nHOST=127.0.0.1\nSTORAGE_BACKEND=json\nDATA_DIR="${dataDir}"\n${content}`);
      Object.assign(environment, { ENV_FILE: envFile }, overrides);
    } else Object.assign(environment, { PORT: String(port), HOST: '127.0.0.1', STORAGE_BACKEND: 'json', ENV_FILE: '', DATA_DIR: dataDir }, overrides);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise((done, reject) => {
      let output = '', errors = '';
      const timeout = setTimeout(() => reject(new Error('Startup did not become ready.')), 10_000);
      child.stderr.on('data', chunk => { errors += chunk; });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Startup exited (${code}): ${errors}`)); });
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('TSS Transportes:')) { clearTimeout(timeout); done(); } });
    });
    return { port, dataDir };
  }
  const selected = await start({}, 'PUBLIC_ORIGIN=https://selected.test:8443\nTRUST_PROXY=1\n');
  const proxyReply = await new Promise((done, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: selected.port, path: '/api/session', headers: { Host: 'selected.test:8443', 'X-Forwarded-Proto': 'https' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => done({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); request.on('error', reject);
  });
  assert.equal(proxyReply.status, 200); assert.equal(proxyReply.body.setupRequired, true);
  assert.ok(JSON.parse(await readFile(join(selected.dataDir, 'jobs.json'), 'utf8')).users);
  const disabled = await start({});
  const localReply = await fetch(`http://127.0.0.1:${disabled.port}/api/session`);
  assert.equal(localReply.status, 200); assert.equal((await localReply.json()).setupRequired, true);
  assert.ok(JSON.parse(await readFile(join(disabled.dataDir, 'jobs.json'), 'utf8')).users);
});

// Public test-only key and certificate; never use or trust these for real devices.
test('HTTPS encrypts sessions, restricts hosts and rejects cross-origin writes', async t => {
  const fixture = new URL('./fixtures/tls/', import.meta.url);
  const [key, cert, ca] = await Promise.all(['server-key.pem', 'server-cert.pem', 'tss-local-ca.pem'].map(name => readFile(new URL(name, fixture))));
  const dir = await mkdtemp(join(tmpdir(), 'tss-https-test-'));
  const server = await createTrackerServer({ dataFile: join(dir, 'jobs.json'), network: { tls: { key, cert }, allowedHosts: ['tss.test:443'] } });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => server.close(done)); for (const name of await readdir(dir)) await unlink(join(dir, name)); await rmdir(dir); });
  function call(path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const request = https.request({ hostname: '127.0.0.1', servername: 'localhost', port: server.address().port, path, method, ca, headers: { Host: 'tss.test:443', 'X-TSS-Request': '1', 'Content-Type': 'application/json', ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on('error', reject); if (body) request.write(JSON.stringify(body)); request.end();
    });
  }
  assert.equal((await call('/api/session')).status, 200);
  assert.equal((await call('/api/session', { headers: { Host: 'untrusted.test:443' } })).status, 403);
  assert.equal((await call('/api/setup', { method: 'POST', body: { name: 'Teste TLS', username: 'tls', password: 'A unique HTTPS test passphrase' }, headers: { Origin: 'http://tss.test:443' } })).status, 403);
  const setup = await call('/api/setup', { method: 'POST', body: { name: 'Teste TLS', username: 'tls', password: 'A unique HTTPS test passphrase' }, headers: { Origin: 'https://tss.test:443' } });
  assert.equal(setup.status, 201); assert.match(setup.headers['set-cookie'][0], /; Secure/); assert.match(setup.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await call('/api/customers', { method: 'POST', body: { name: 'Origem recusada' }, headers: { Cookie: setup.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': setup.body.csrfToken, Origin: 'https://localhost:' + server.address().port } })).status, 403);
});
