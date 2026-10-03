// Temporary, fictional browser QA workspace. Never reads the company's data file.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackerServer } from '../server.mjs';
const directory = await mkdtemp(join(tmpdir(), 'tss-ui-qa-'));
const server = await createTrackerServer({ dataFile: join(directory, 'jobs.json') });
server.listen(4318, '127.0.0.1', async () => {
  const response = await fetch('http://127.0.0.1:4318/api/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1' },
    body: JSON.stringify({ name: 'Gerente de teste', username: 'qa.manager', password: 'Teste-local-apenas-2026' }),
  });
  if (!response.ok) throw new Error('Falha na configuração temporária.');
  console.log('QA fictícia: http://127.0.0.1:4318 — qa.manager / Teste-local-apenas-2026');
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
