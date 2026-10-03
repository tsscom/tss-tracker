import { loadStore, persist } from './storage.mjs';

export async function createStorageRepository({ backend = 'json', dataFile, connectionString, schema } = {}) {
  if (backend === 'postgresql' || backend === 'postgres') {
    if (!connectionString) throw new Error('Configure DATABASE_URL antes de iniciar o PostgreSQL. Não foi utilizado o ficheiro JSON.');
    const { createPostgresRepository } = await import('./postgres-storage.mjs');
    return createPostgresRepository({ connectionString, ...(schema ? { schema } : {}) });
  }
  if (backend !== 'json') throw new Error('STORAGE_BACKEND deve ser json ou postgresql.');
  let store = await loadStore(dataFile), pending = Promise.resolve();
  return {
    kind: 'json',
    async read() { return structuredClone(store); },
    mutate(change) {
      const result = pending.then(async () => {
        const next = structuredClone(store), value = await change(next);
        await persist(dataFile, next);
        store = next;
        return value;
      });
      pending = result.catch(() => {});
      return result;
    },
    async close() { await pending; },
  };
}
