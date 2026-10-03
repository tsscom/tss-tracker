import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareStoreForMigration } from '../lib/storage.mjs';
import { loadLocalEnv } from './postgres-env.mjs';

const collections = ['users', 'customers', 'jobs', 'quotes', 'yard', 'workOrders', 'invoices', 'audit'];
const labels = { users: 'Utilizadores', customers: 'Clientes', jobs: 'Serviços', quotes: 'Propostas', yard: 'Registos de parque', workOrders: 'Ordens de oficina', invoices: 'Documentos internos', audit: 'Eventos de auditoria' };
const defaultSource = fileURLToPath(new URL('../data/jobs.json', import.meta.url));

function migrationError(message) { return Object.assign(new Error(message), { safeForConsole: true }); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const canonicalStore = value => JSON.stringify(canonical(value));

/** JSON is read only. The destination must be empty; initialize also checks this transactionally. */
export async function runMigration({ source = defaultSource, apply = false, connectionString = process.env.DATABASE_URL, repositoryFactory } = {}) {
  const sourcePath = resolve(source);
  let bytes, parsed;
  try { bytes = await readFile(sourcePath); }
  catch { throw migrationError('Não foi possível ler a origem JSON. Indique um ficheiro existente com --source; não são criados dados de exemplo.'); }
  try { parsed = JSON.parse(bytes.toString('utf8')); }
  catch { throw migrationError('A origem não contém JSON válido. O ficheiro foi preservado.'); }
  const backupPath = `${sourcePath}.postgres-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
  let prepared;
  try { prepared = await prepareStoreForMigration(parsed, { backupFile: apply ? backupPath : null }); }
  catch { throw migrationError('Os dados de origem não passaram a validação. Corrija a origem numa cópia antes de importar; o ficheiro foi preservado.'); }
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    source: sourcePath,
    sourceSchemaVersion: parsed.schemaVersion,
    schemaVersion: prepared.schemaVersion,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    counts: Object.fromEntries(collections.map(key => [key, prepared[key].length])),
  };
  if (!apply) return summary;
  try {
    const url = new URL(connectionString);
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) throw new Error();
  } catch { throw migrationError('Defina DATABASE_URL no ficheiro .env com uma ligação PostgreSQL válida. O endereço e a palavra-passe não são apresentados.'); }
  // Refuse a source changed since validation. The operator must stop the JSON server first.
  let currentBytes;
  try { currentBytes = await readFile(sourcePath); }
  catch { throw migrationError('A origem deixou de estar disponível. Nenhum registo foi importado.'); }
  if (!bytes.equals(currentBytes)) throw migrationError('A origem mudou durante a validação. Termine a aplicação e repita a migração.');
  try {
    await writeFile(backupPath, bytes, { flag: 'wx', mode: 0o600 });
    if (!bytes.equals(await readFile(backupPath))) throw new Error();
  } catch { throw migrationError('Não foi possível criar e verificar uma cópia exata da origem. A base de dados não foi alterada.'); }
  let repository;
  try {
    const factory = repositoryFactory ?? (await import('../lib/postgres-storage.mjs')).createPostgresRepository;
    repository = await factory({ connectionString });
    const imported = await repository.initialize(prepared);
    // The repository performs this same full comparison before committing its transaction.
    if (canonicalStore(imported) !== canonicalStore(prepared)) throw migrationError('A verificação integral após a importação falhou. Não inicie a aplicação; conserve a origem e a cópia de segurança para investigar.');
    return { ...summary, backupPath, verified: true };
  } finally { if (repository) await repository.close(); }
}

const help = `Migração TSS: JSON → PostgreSQL

  npm run db:migrate                         Validar e contar, sem escrever nem ligar à base de dados
  npm run db:migrate -- --source data/jobs.json
  npm run db:migrate -- --apply               Criar cópia exata e importar numa base de dados vazia
  npm run db:migrate -- --help

DATABASE_URL é lido do ambiente ou do ficheiro .env da aplicação.
Termine o servidor JSON antes de usar --apply. A origem nunca é substituída.
Não há opção para apagar ou sobrescrever dados já existentes em PostgreSQL.
`;

function publicError(error) {
  if (error.safeForConsole) return error.message;
  const code = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null;
  if (['TSS_DATABASE_ALREADY_INITIALIZED', 'TSS_DATABASE_NOT_EMPTY'].includes(code)) return 'A base de dados já contém registos. A importação foi recusada sem os substituir.';
  if (['ERR_MODULE_NOT_FOUND', 'TSS_POSTGRES_DRIVER_MISSING'].includes(code)) return 'Instale as dependências com npm install antes de aplicar a migração.';
  return `A importação foi interrompida. Confirme a instalação do PostgreSQL, a ligação e as permissões. A origem JSON foi preservada.${code ? ` Código: ${code}.` : ''}`;
}

export async function main(args = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { source: { type: 'string' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }));
    if (values.apply && values['dry-run']) throw new Error();
  } catch { throw migrationError('Argumentos inválidos. Consulte npm run db:migrate -- --help; use --apply ou --dry-run, sem os combinar.'); }
  if (values.help) { process.stdout.write(help); return; }
  if (process.env.ENV_FILE !== '') await loadLocalEnv(process.env.ENV_FILE ? resolve(process.env.ENV_FILE) : undefined);
  const result = await runMigration({ source: values.source, apply: values.apply === true });
  process.stdout.write(`${result.mode === 'apply' ? 'Importação concluída e verificada.' : 'Validação concluída. Simulação: sem ligação nem escrita na base de dados.'}\n`);
  for (const key of collections) process.stdout.write(`${labels[key]}: ${result.counts[key]}\n`);
  process.stdout.write(`Esquema da origem: ${result.sourceSchemaVersion}; esquema preparado: ${result.schemaVersion}.\nSHA-256 da origem: ${result.sourceSha256}\n`);
  if (result.backupPath) process.stdout.write(`Cópia exata: ${result.backupPath}\n`);
  if (result.mode === 'dry-run') process.stdout.write('Para importar numa base de dados vazia, termine o servidor e execute npm run db:migrate -- --apply.\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`Migração interrompida: ${publicError(error)}\n`); process.exitCode = 1; });
}
