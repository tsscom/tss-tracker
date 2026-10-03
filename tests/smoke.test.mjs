import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackerServer } from '../server.mjs';
import { emptyStore } from '../tools/empty-store.mjs';
import { smoke } from '../tools/smoke.mjs';

const PATHS = ['/healthz', '/', '/motorista', '/manifest.webmanifest', '/api/session'];

async function listen(server, t) {
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await server.storage?.close();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('smoke checks the real app through HTTPS proxy headers without changing its isolated store', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'tss-smoke-test-'));
  const dataFile = join(folder, 'jobs.json');
  const initial = JSON.stringify(emptyStore(), null, 2) + '\n';
  await writeFile(dataFile, initial, { mode: 0o600 });
  t.after(async () => { await unlink(dataFile); await rmdir(folder); });
  const server = await createTrackerServer({
    dataFile,
    network: { publicOrigin: 'https://tss-smoke.test', trustProxy: true },
  });
  const requests = [];
  server.prependListener('request', request => requests.push({ method: request.method, path: request.url, host: request.headers.host, scheme: request.headers['x-forwarded-proto'] }));
  const base = await listen(server, t);
  await smoke(base, { proxyOrigin: 'https://tss-smoke.test' });
  assert.deepEqual(requests, PATHS.map(path => ({ method: 'GET', path, host: 'tss-smoke.test', scheme: 'https' })));
  assert.equal(await readFile(dataFile, 'utf8'), initial);
  assert.deepEqual(await server.storage.read(), emptyStore());
});

test('smoke rejects unhealthy readiness, unexpected sessions, and failed routes', async t => {
  for (const scenario of [
    { path: '/healthz', status: 200, body: { status: 'unavailable' }, expected: /Readiness check failed/ },
    { path: '/api/session', status: 200, body: { setupRequired: 'false' }, expected: /Session endpoint returned an unexpected response/ },
    { path: '/motorista', status: 503, body: {}, expected: /\/motorista returned 503/ },
  ]) {
    await t.test(scenario.path, async t => {
      const requests = [];
      const server = http.createServer((request, response) => {
        requests.push(request.url);
        const selected = request.url === scenario.path;
        response.writeHead(selected ? scenario.status : 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(selected ? scenario.body : request.url === '/healthz' ? { status: 'ok' } : { setupRequired: true }));
      });
      await assert.rejects(smoke(await listen(server, t)), scenario.expected);
      assert.deepEqual(requests, PATHS.slice(0, PATHS.indexOf(scenario.path) + 1));
    });
  }
});

test('smoke refuses credentials, paths, unsupported schemes, queries, and fragments before connecting', async t => {
  let connections = 0;
  const server = http.createServer((request, response) => response.end('{}'));
  server.on('connection', () => { connections++; });
  const base = await listen(server, t);
  const authority = new URL(base).host;
  for (const invalid of [
    `http://user:password@${authority}`,
    `${base}/api/session`,
    `ftp://${authority}`,
    `${base}/?environment=production`,
    `${base}/#fragment`,
  ]) {
    await assert.rejects(smoke(invalid), /origin without credentials or a path/);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connections, 0);
});
