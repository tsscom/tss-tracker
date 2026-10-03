// Resume an explicitly named temporary QA store, without reseeding or touching company data.
import { resolve, dirname, basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTrackerServer } from '../server.mjs';
const file = resolve(process.argv[2] ?? '');
if (basename(file) !== 'jobs.json' || dirname(dirname(file)).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !/^tss-(?:mobile-qa|v3-preview|ui-qa)-/.test(basename(dirname(file)))) throw new Error('Indique apenas um jobs.json de uma pasta temporária de QA da TSS.');
const port = Number(process.argv[3] ?? 4320);
if (![4318, 4320].includes(port)) throw new Error('Use a porta de QA 4318 ou 4320.');
const server = await createTrackerServer({ dataFile: file });
server.listen(port, '127.0.0.1', () => console.log(`QA retomada sem alterar contas/registos: http://127.0.0.1:${port}`));
const stop = () => server.close(async () => { await server.storage.close(); process.exit(0); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
