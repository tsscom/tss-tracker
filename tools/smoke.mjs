import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';

function probe(url, headers) {
  return new Promise((resolveResult, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolveResult({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(15000, () => request.destroy(new Error('Smoke request timed out.')));
    request.on('error', reject);
  });
}

export async function smoke(base, { proxyOrigin } = {}) {
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Use an application origin without credentials or a path.');
  const headers = proxyOrigin ? { Host: new URL(proxyOrigin).host, 'X-Forwarded-Proto': 'https' } : {};
  for (const path of ['/healthz', '/', '/motorista', '/manifest.webmanifest', '/api/session']) {
    const response = await probe(new URL(path, origin), headers);
    if (response.status !== 200) throw new Error(`Smoke check failed: ${path} returned ${response.status}.`);
    if (path === '/healthz' && JSON.parse(response.body).status !== 'ok') throw new Error('Readiness check failed.');
    if (path === '/api/session' && typeof JSON.parse(response.body).setupRequired !== 'boolean') throw new Error('Session endpoint returned an unexpected response.');
    process.stdout.write(`OK ${path}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [base, proxyOrigin] = process.argv.slice(2);
  smoke(base, { proxyOrigin }).catch(error => {
    process.stderr.write(`${error.message.startsWith('Smoke check failed:') ? error.message : 'Smoke check failed. Check the origin, service readiness and certificate trust.'}\n`);
    process.exitCode = 1;
  });
}
