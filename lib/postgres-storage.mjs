import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateStore } from './storage.mjs';

const COLLECTIONS = Object.freeze([
  ['users', 'users'], ['customers', 'customers'], ['jobs', 'jobs'],
  ['quotes', 'quotes'], ['yard', 'yard'], ['workOrders', 'work_orders'],
  ['invoices', 'invoices'], ['audit', 'audit'],
  ['vehicles', 'vehicles'], ['drivers', 'drivers'], ['opportunities', 'opportunities'],
  ['activities', 'activities'], ['incidents', 'incidents'], ['costs', 'costs'],
  ['attachments', 'attachments'], ['mobileOperations', 'mobile_operations'],
]);
const COLLECTION_KEYS = new Set(COLLECTIONS.map(([key]) => key));
const MIGRATIONS = [{ version: 1, file: new URL('../migrations/001_postgresql.sql', import.meta.url) }, { version: 2, file: new URL('../migrations/002_operations.sql', import.meta.url) }];
// All repository instances use this database-scoped transaction lock. Business
// operations currently load the complete domain store, so they must serialize.
// A later repository/domain redesign can use row locks and targeted SQL queries.
const LOCK_NAMESPACE = 18453;
const LOCK_ID = 2201;
const SAFE_SCHEMA = /^(?:tss|tss_test_[a-f0-9]{32})$/;

function failure(code, message, status = 503) {
  return Object.assign(new Error(message), { code, status });
}

function databaseError(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('TSS_')) return error;
  const code = typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'TSS_POSTGRES_FAILURE';
  if (['23505', '23503', '23514', '23502'].includes(code)) {
    return failure(code, 'O PostgreSQL recusou um registo duplicado, inválido ou uma referência inexistente. Nenhuma alteração foi guardada.', 409);
  }
  if (['40001', '40P01', '55P03', '57014'].includes(code)) {
    return failure(code, 'A base de dados está ocupada. Atualize a página e tente novamente; nenhuma alteração desta operação foi guardada.');
  }
  // Do not propagate the driver message, connection options, SQL, or original
  // cause: malformed URLs and driver errors can contain credentials or data.
  return failure(code, 'Não foi possível completar a operação no PostgreSQL. Verifique a configuração e a disponibilidade da base de dados.');
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function metadata(store) {
  return Object.fromEntries(Object.entries(store).filter(([key]) => !COLLECTION_KEYS.has(key)));
}

function normalizeStore(store) {
  // The application already persists JSON. Round-tripping here keeps the same
  // semantics and prevents undefined properties from causing spurious diffs.
  let copy;
  try { copy = JSON.parse(JSON.stringify(store)); }
  catch { throw failure('TSS_STORE_INVALID', 'Os dados a guardar não são um documento JSON válido.', 400); }
  validateStore(copy);
  return copy;
}

export async function createPostgresRepository({ connectionString, pool: providedPool, schema = 'tss', migrate = true } = {}) {
  if (!SAFE_SCHEMA.test(schema)) throw failure('TSS_SCHEMA_INVALID', 'O esquema PostgreSQL deve ser tss ou um esquema isolado de teste válido.', 400);
  if (!providedPool && (typeof connectionString !== 'string' || !connectionString.trim())) {
    throw failure('TSS_DATABASE_URL_REQUIRED', 'Configure DATABASE_URL antes de selecionar PostgreSQL.', 400);
  }
  let pool = providedPool;
  if (!pool) {
    let Pool;
    try {
      const driver = await import('pg');
      Pool = driver.Pool ?? driver.default?.Pool;
      if (typeof Pool !== 'function') throw new Error('Driver indisponível');
    }
    catch { throw failure('TSS_POSTGRES_DRIVER_MISSING', 'Instale as dependências da aplicação com npm install para utilizar PostgreSQL.'); }
    try {
      pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
    } catch (error) { throw databaseError(error); }
  }
  // pg emits errors for disconnected idle clients. Keep those from becoming an
  // unhandled process exception; active requests still receive sanitized errors.
  const onIdleError = () => {};
  pool.on?.('error', onIdleError);
  let closed = false;
  let closePromise;
  const name = table => `${schema}.${table}`; // Only fixed, internal table names.

  async function transaction(mode, work) {
    if (closed) throw failure('TSS_DATABASE_CLOSED', 'A ligação à base de dados já foi encerrada.');
    let client;
    try { client = await pool.connect(); }
    catch (error) { throw databaseError(error); }
    let callbackError;
    let discardClient = false;
    const preserveError = error => { callbackError = error; throw error; };
    try {
      await client.query(mode === 'read' ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      if (mode !== 'read') await client.query('SELECT pg_advisory_xact_lock($1, $2)', [LOCK_NAMESPACE, LOCK_ID]);
      const result = await work(client, preserveError);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch { discardClient = true; /* Original sanitized failure wins. */ }
      if (error === callbackError) throw error;
      throw databaseError(error);
    } finally {
      // An unsuccessful rollback leaves the client unusable or in an unknown
      // transaction state. pg discards a client when release receives an error.
      client.release(discardClient ? new Error('Ligação PostgreSQL descartada após falha de rollback.') : undefined);
    }
  }

  async function applyMigrations() {
    const migrations = await Promise.all(MIGRATIONS.map(async migration => {
      const sql = await readFile(migration.file, 'utf8');
      return { ...migration, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }));
    return transaction('write', async client => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${name('schema_migrations')} (version integer PRIMARY KEY, checksum text NOT NULL, installed_at timestamptz NOT NULL DEFAULT now())`);
      // set_config accepts the schema as a value, avoiding arbitrary identifier
      // interpolation. pg_catalog remains available for built-in types/functions.
      await client.query("SELECT set_config('search_path', $1, true)", [schema + ',pg_catalog']);
      for (const migration of migrations) {
        const installed = await client.query(`SELECT checksum FROM ${name('schema_migrations')} WHERE version = $1`, [migration.version]);
        if (installed.rows.length) {
          if (installed.rows[0].checksum !== migration.checksum) throw failure('TSS_MIGRATION_CHANGED', 'Uma migração PostgreSQL já aplicada foi alterada. Preserve a migração original e crie uma nova versão.');
          continue;
        }
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${name('schema_migrations')} (version, checksum) VALUES ($1, $2)`, [migration.version, migration.checksum]);
      }
      return migrations.map(item => item.version);
    });
  }

  async function load(client) {
    const result = await client.query(`SELECT payload FROM ${name('metadata')} WHERE singleton = true`);
    if (result.rows.length !== 1) {
      throw failure('TSS_DATABASE_NOT_INITIALIZED', 'A base de dados PostgreSQL ainda não foi inicializada. Importe explicitamente o ficheiro de dados existente antes de iniciar a aplicação.');
    }
    const store = { ...result.rows[0].payload };
    // Keep one transaction/client so all collections share the same snapshot.
    for (const [key, table] of COLLECTIONS) {
      const rows = await client.query(`SELECT payload FROM ${name(table)} ORDER BY ordinal, id`);
      store[key] = rows.rows.map(row => row.payload);
    }
    validateStore(store);
    return store;
  }

  async function saveDifference(client, before, after) {
    // Referential constraints are deferred until COMMIT, permitting quote/job
    // creation (a cyclic link) and complete imports in a single transaction.
    for (const [key, table] of COLLECTIONS) {
      const previous = new Map((before?.[key] ?? []).map((item, index) => [item.id, { item, index }]));
      const nextIds = new Set(after[key].map(item => item.id));
      const deleted = [...previous.keys()].filter(id => !nextIds.has(id));
      if (deleted.length) await client.query(`DELETE FROM ${name(table)} WHERE id = ANY($1::text[])`, [deleted]);
      for (const [index, item] of after[key].entries()) {
        const old = previous.get(item.id);
        if (old && old.index === index && canonical(old.item) === canonical(item)) continue;
        await client.query(`INSERT INTO ${name(table)} (id, ordinal, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal, payload = EXCLUDED.payload`, [item.id, index, JSON.stringify(item)]);
      }
    }
    const nextMetadata = metadata(after);
    if (!before || canonical(metadata(before)) !== canonical(nextMetadata)) {
      await client.query(`INSERT INTO ${name('metadata')} (singleton, payload) VALUES (true, $1::jsonb) ON CONFLICT (singleton) DO UPDATE SET payload = EXCLUDED.payload`, [JSON.stringify(nextMetadata)]);
    }
  }

  const repository = {
    kind: 'postgresql',
    schema,
    applyMigrations,
    async read() { return transaction('read', client => load(client)); },
    async mutate(change) {
      if (typeof change !== 'function') throw failure('TSS_MUTATION_INVALID', 'A operação da base de dados é inválida.', 400);
      return transaction('write', async (client, preserveError) => {
        const before = await load(client);
        const draft = structuredClone(before);
        let result;
        try { result = await change(draft); }
        catch (error) { preserveError(error); }
        let after;
        try { after = normalizeStore(draft); }
        catch (error) { preserveError(error); }
        await saveDifference(client, before, after);
        return result;
      });
    },
    async initialize(source) {
      const expected = normalizeStore(source);
      return transaction('write', async client => {
        const existing = await client.query(`SELECT singleton FROM ${name('metadata')} LIMIT 1`);
        if (existing.rows.length) throw failure('TSS_DATABASE_NOT_EMPTY', 'A base de dados PostgreSQL já contém dados. A importação foi recusada para preservar os registos existentes.', 409);
        for (const [, table] of COLLECTIONS) {
          const rows = await client.query(`SELECT id FROM ${name(table)} LIMIT 1`);
          if (rows.rows.length) throw failure('TSS_DATABASE_NOT_EMPTY', 'A base de dados PostgreSQL contém registos sem metadados. A importação foi recusada.', 409);
        }
        await saveDifference(client, null, expected);
        const actual = await load(client);
        if (canonical(actual) !== canonical(expected)) throw failure('TSS_IMPORT_VERIFICATION_FAILED', 'A verificação da importação falhou. Nenhum registo foi importado.');
        return actual;
      });
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      pool.removeListener?.('error', onIdleError);
      closePromise = providedPool ? Promise.resolve() : Promise.resolve().then(() => pool.end()).catch(error => { throw databaseError(error); });
      return closePromise;
    },
  };
  try { if (migrate) await applyMigrations(); }
  catch (error) { await repository.close().catch(() => {}); throw error; }
  return repository;
}
