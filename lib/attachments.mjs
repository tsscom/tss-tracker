import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, text, requirePermission } from './security.mjs';

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
const KINDS = ['pod-photo', 'signature', 'document', 'incident-photo'];
export function authorizeJobDocument(store, actor, jobId, writing = false) {
  requirePermission(actor, writing ? 'documents.write' : 'documents.read');
  const job = store.jobs.find(value => value.id === jobId);
  if (!job) fail(404, 'O serviço não existe.');
  if (actor.role === 'motorista' && job.driverUserId !== actor.id) fail(403, 'Só pode consultar ou enviar documentos dos seus serviços.');
  return job;
}
export function publicAttachment(record) {
  const { storageKey, ...safe } = record;
  return { ...safe, url: `/api/attachments/${record.id}` };
}
export function decodeAttachment(input) {
  const name = text(input.name, 'nome do ficheiro', 160);
  if (/[\u0000-\u001f\\/]/.test(name)) fail(400, 'Nome de ficheiro inválido.');
  if (!KINDS.includes(input.kind)) fail(400, 'Tipo de documento inválido.');
  if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.dataBase64)) fail(400, 'Ficheiro inválido ou superior a 3 MB.');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== input.dataBase64) fail(400, 'Ficheiro inválido ou superior a 3 MB.');
  const valid = input.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : input.mimeType === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : input.mimeType === 'application/pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : false;
  if (!valid) fail(400, 'Envie um ficheiro JPG, PNG ou PDF com conteúdo válido.');
  if (input.kind === 'signature' && input.mimeType !== 'image/png') fail(400, 'A assinatura deve ser uma imagem PNG.');
  return { name, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
export async function saveAttachment(store, actor, input, folder, audit) {
  const job = authorizeJobDocument(store, actor, input.jobId, true);
  const { name, bytes, sha256 } = decodeAttachment(input);
  const storageKey = sha256 + '.bin';
  await mkdir(folder, { recursive: true });
  try { await writeFile(join(folder, storageKey), bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readFile(join(folder, storageKey));
    if (createHash('sha256').update(prior).digest('hex') !== sha256) fail(503, 'O documento guardado falhou a verificação. Contacte o gerente.');
  }
  // Immutable content-addressed blobs survive an uncertain COMMIT outcome.
  // A rolled-back upload can leave an unreferenced blob, never a missing proof.
  const at = new Date().toISOString();
  const attachment = { id: randomUUID(), jobId: job.id, createdBy: actor.id, createdAt: at, updatedAt: at, version: 1, kind: input.kind, name, mimeType: input.mimeType, sizeBytes: bytes.length, sha256, storageKey, ...(input.operationId ? { operationId: input.operationId } : {}) };
  (store.attachments ??= []).push(attachment);
  audit(store, actor, 'document.upload', 'attachment', attachment.id, { jobId: job.id, kind: attachment.kind, sizeBytes: bytes.length });
  return { attachment: publicAttachment(attachment) };
}
export async function readAttachment(store, actor, id, folder) {
  const record = (store.attachments ?? []).find(value => value.id === id);
  if (!record) fail(404, 'O documento não existe.');
  authorizeJobDocument(store, actor, record.jobId);
  if (!/^[a-f0-9]{64}\.bin$/.test(record.storageKey)) fail(503, 'Referência do documento inválida.');
  let bytes;
  try { bytes = await readFile(join(folder, record.storageKey)); }
  catch { fail(503, 'O ficheiro do documento está indisponível. Verifique a cópia de segurança dos anexos.'); }
  if (bytes.length !== record.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) fail(503, 'O ficheiro do documento falhou a verificação.');
  return { record, bytes };
}
export function validatePodAttachments(store, actor, jobId, input) {
  if (!input.pod || input.pod.attachmentIds === undefined) return;
  authorizeJobDocument(store, actor, jobId);
  const ids = input.pod.attachmentIds;
  if (!Array.isArray(ids) || ids.length > 12 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) fail(400, 'Lista de documentos do comprovativo inválida.');
  for (const id of ids) if (!(store.attachments ?? []).some(record => record.id === id && record.jobId === jobId && ['signature', 'pod-photo', 'document'].includes(record.kind))) fail(400, 'Um documento do comprovativo não pertence a este serviço.');
}
