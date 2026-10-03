// Capture and verify existing domain records around an additive local v3 upgrade.
// This is a private record snapshot, not a replacement for pg_dump/database backups.
import pg from 'pg';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { loadLocalEnv } from './postgres-env.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
await loadLocalEnv(join(root, '.env'));
const action = process.argv[2];
if (!['--capture', '--verify'].includes(action)) throw new Error('Use --capture ou --verify caminho-da-copia.');
if (!['postgres', 'postgresql'].includes(process.env.STORAGE_BACKEND)) throw new Error('Este verificador exige o PostgreSQL configurado na aplicação.');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis:5000 });
const tables = [['users','users'],['customers','customers'],['jobs','jobs'],['quotes','quotes'],['yard','yard'],['workOrders','work_orders'],['invoices','invoices'],['audit','audit']];
try {
  const client = await pool.connect();
  let store;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    store = (await client.query('SELECT payload FROM tss.metadata WHERE singleton = true')).rows[0]?.payload;
    if (!store) throw new Error('A base não tem registos inicializados.');
    for (const [key, table] of tables) store[key] = (await client.query(`SELECT payload FROM tss.${table} ORDER BY ordinal, id`)).rows.map(row => row.payload);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; } finally { client.release(); }
  if (action === '--capture') {
    const file = join(root, 'data', `postgres-before-v3-${new Date().toISOString().replace(/[:.]/g,'-')}.json`);
    await mkdir(dirname(file),{recursive:true});
    await writeFile(file, JSON.stringify(store,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log('Cópia privada dos registos existentes: '+file);
    console.log(JSON.stringify(Object.fromEntries(tables.map(([key])=>[key,store[key].length]))));
  } else {
    const file = resolve(process.argv[3] ?? '');
    if (!file.startsWith(join(root,'data') + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Use uma cópia privada dentro de data.');
    const before = JSON.parse(await readFile(file,'utf8'));
    assert.deepEqual(Object.fromEntries(Object.keys(before).map(key=>[key,store[key]])),before,'Os registos anteriores diferem da cópia. Preserve-a e reveja a alteração.');
    console.log('Verificado: todas as contas, credenciais, registos, ordem, metadados e auditoria existentes foram preservados.');
    console.log(JSON.stringify(Object.fromEntries(tables.map(([key])=>[key,store[key].length]))));
  }
} catch (error) { console.error(error.code ? 'Falha na verificação: '+error.code : error.message); process.exitCode=1; } finally { await pool.end(); }
