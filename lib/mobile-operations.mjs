import { createHash, randomUUID } from 'node:crypto';
import { fail } from './security.mjs';

export const operationIdValid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
// Caller resolves permissions and assignment again from the locked transaction,
// including before a replay. Receipts and business changes commit together.
export async function applyMobileOperation(store, actor, input, scope, change) {
  if (input.operationId === undefined) return change();
  if (!operationIdValid(input.operationId)) fail(400, 'Identificador de envio inválido.');
  const normalizedId = input.operationId.toLowerCase();
  const requestHash = createHash('sha256').update(canonical({ scope, input: { ...input, operationId: normalizedId } })).digest('hex');
  const receipts = store.mobileOperations ??= [];
  const existing = receipts.find(item => item.userId === actor.id && item.operationId.toLowerCase() === normalizedId);
  if (existing) {
    if (existing.requestHash !== requestHash || existing.scope !== scope) fail(409, 'Este identificador já foi utilizado para outro envio. Reveja o registo pendente.');
    return { ...structuredClone(existing.result), operationId: input.operationId, acknowledged: true };
  }
  const result = await change();
  const saved = JSON.parse(JSON.stringify(result));
  receipts.push({ id: randomUUID(), userId: actor.id, operationId: normalizedId, scope, requestHash, result: saved, createdAt: new Date().toISOString(), version: 1 });
  return { ...result, operationId: input.operationId, acknowledged: true };
}
