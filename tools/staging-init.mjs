import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPostgresRepository } from '../lib/postgres-storage.mjs';
import { emptyStore } from './empty-store.mjs';

export async function initializeStaging({ connectionString, bootstrap, repositoryFactory = createPostgresRepository }) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Staging requires its dedicated database connection.'); }
  if (bootstrap !== '1' || !['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== 'database' || url.pathname !== '/tss_staging' || url.search || url.hash) {
    throw new Error('Bootstrap is restricted to the local Compose database tss_staging.');
  }
  const repository = await repositoryFactory({ connectionString });
  try {
    try { await repository.read(); return 'existing'; }
    catch (error) { if (error.code !== 'TSS_DATABASE_NOT_INITIALIZED') throw error; }
    try { await repository.initialize(emptyStore()); }
    catch (error) {
      if (error.code !== 'TSS_DATABASE_NOT_EMPTY') throw error;
      await repository.read();
      return 'existing';
    }
    return 'initialized';
  } finally { await repository.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  initializeStaging({ connectionString: process.env.DATABASE_URL, bootstrap: process.env.STAGING_BOOTSTRAP })
    .then(result => process.stdout.write(`Local staging database: ${result}.\n`))
    .catch(() => { process.stderr.write('Local staging initialization failed. Check the dedicated database configuration and logs.\n'); process.exitCode = 1; });
}
