import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
let derivations = 0;
const derivationWaiters = [];
async function derive(...args) {
  if (derivations < 2) derivations++;
  else {
    if (derivationWaiters.length >= 40) fail(429, 'O serviço de autenticação está ocupado. Tente novamente dentro de momentos.');
    await new Promise(resolve => derivationWaiters.push(resolve));
  }
  try { return await scrypt(...args); }
  finally { if (derivationWaiters.length) derivationWaiters.shift()(); else derivations--; }
}
export const PASSWORD_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export const token = () => randomBytes(32).toString('hex');
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function text(value, label, max = 180, required = true) {
  if (value != null && typeof value !== 'string') fail(400, `O campo ${label} é inválido.`);
  const result = (value ?? '').trim();
  if (required && !result) fail(400, `Preencha o campo ${label}.`);
  if (result.length > max) fail(400, `O campo ${label} pode ter até ${max} caracteres.`);
  return result;
}
export function username(value) {
  const result = text(value, 'utilizador', 60).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,59}$/.test(result)) fail(400, 'O utilizador deve ter 3–60 letras, números, pontos, hífen ou sublinhado.');
  return result;
}
export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) fail(400, 'A palavra-passe deve ter entre 12 e 128 caracteres. Use uma frase longa e única.');
  return value;
}
export async function hashPassword(value) {
  const password = validatePassword(value);
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64, PASSWORD_OPTIONS);
  return { algorithm: 'scrypt', salt, hash: hash.toString('hex'), N: PASSWORD_OPTIONS.N, r: 8, p: 1 };
}
export async function verifyPassword(value, credential) {
  if (typeof value !== 'string' || value.length > 128 || !credential || credential.algorithm !== 'scrypt') return false;
  const actual = await derive(value, credential.salt, 64, { N: credential.N, r: credential.r, p: credential.p, maxmem: PASSWORD_OPTIONS.maxmem });
  const expected = Buffer.from(credential.hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const allBusiness = ['jobs.read', 'jobs.plan', 'jobs.execute', 'jobs.cancel', 'customers.read', 'customers.write', 'customers.credit', 'quotes.read', 'quotes.write', 'quotes.approve', 'quotes.accept', 'yard.read', 'yard.write', 'workshop.read', 'workshop.write', 'workshop.approve', 'workshop.release', 'invoices.read', 'invoices.write', 'invoices.approve', 'invoices.issue', 'invoices.pay', 'audit.read', 'export'];
export const ROLES = [
  { id: 'gerente', label: 'Gerente / proprietário', permissions: [...allBusiness, 'users.read', 'users.write', 'workflows.read', 'workflows.write'] },
  { id: 'administrador', label: 'Administrador de identidade e sistema', permissions: ['users.read', 'users.write', 'audit.read'] },
  { id: 'comercial', label: 'Comercial / CRM', permissions: ['customers.read', 'customers.write', 'quotes.read', 'quotes.write', 'quotes.accept', 'jobs.read', 'export'] },
  { id: 'operacoes', label: 'Operações / tráfego', permissions: ['customers.read', 'quotes.read', 'jobs.read', 'jobs.plan', 'jobs.execute', 'jobs.cancel', 'yard.read', 'workshop.read', 'export'] },
  { id: 'motorista', label: 'Motorista', permissions: ['jobs.read', 'jobs.execute'] },
  { id: 'parque', label: 'Parque / portaria', permissions: ['jobs.read', 'yard.read', 'yard.write', 'workshop.read'] },
  { id: 'oficina', label: 'Oficina / mecânico', permissions: ['jobs.read', 'yard.read', 'workshop.read', 'workshop.write'] },
  { id: 'financeiro', label: 'Financeiro / cobranças', permissions: ['customers.read', 'quotes.read', 'jobs.read', 'invoices.read', 'invoices.write', 'invoices.issue', 'invoices.pay', 'export'] },
  { id: 'auditor', label: 'Auditor — consulta', permissions: ['customers.read', 'quotes.read', 'jobs.read', 'yard.read', 'workshop.read', 'invoices.read', 'audit.read', 'export', 'workflows.read'] },
];
const operationalPermissions = {
  gerente: ['fleet.read', 'fleet.write', 'drivers.read', 'drivers.write', 'sales.read', 'sales.write', 'costs.read', 'costs.write', 'incidents.read', 'incidents.write', 'incidents.resolve', 'documents.read', 'documents.write', 'dashboard.read'],
  comercial: ['sales.read', 'sales.write', 'incidents.read', 'documents.read', 'documents.write'],
  operacoes: ['fleet.read', 'fleet.write', 'drivers.read', 'drivers.write', 'incidents.read', 'incidents.write', 'incidents.resolve', 'documents.read', 'documents.write'],
  motorista: ['drivers.read', 'incidents.read', 'incidents.write', 'documents.read', 'documents.write'],
  parque: ['fleet.read', 'incidents.read', 'incidents.write', 'documents.read'],
  oficina: ['fleet.read', 'incidents.read', 'incidents.write', 'incidents.resolve', 'documents.read', 'documents.write'],
  financeiro: ['costs.read', 'costs.write', 'incidents.read', 'documents.read', 'documents.write'],
  auditor: ['fleet.read', 'drivers.read', 'sales.read', 'costs.read', 'incidents.read', 'documents.read', 'dashboard.read'],
};
for (const role of ROLES) role.permissions.push(...(operationalPermissions[role.id] ?? []));
export const permissionsFor = user => ROLES.find(role => role.id === user.role)?.permissions ?? [];
export const can = (user, permission) => permissionsFor(user).includes(permission);
export function requirePermission(user, permission) { if (!can(user, permission)) fail(403, 'O seu papel não autoriza esta operação.'); }
export function publicUser(user) { return { id: user.id, name: user.name, username: user.username, role: user.role, active: user.active, createdAt: user.createdAt, updatedAt: user.updatedAt, version: user.version ?? 1 }; }
export function approval(user, creators, input) {
  if (user.role !== 'gerente') fail(403, 'A aprovação exige o papel de gerente.');
  const own = creators.filter(Boolean).includes(user.id);
  if (input.ownerOverride === true) {
    const reason = text(input.reason, 'justificação da aprovação pelo próprio gerente', 1000);
    if (reason.length < 20) fail(400, 'A aprovação pelo próprio gerente exige uma justificação de pelo menos 20 caracteres.');
    return { ownerOverride: true, reason, selfApproval: own };
  }
  if (own) fail(409, 'Não pode aprovar o seu próprio pedido. Um segundo gerente pode aprovar, ou use a aprovação pelo próprio gerente com uma justificação registada de pelo menos 20 caracteres.');
  return { ownerOverride: false, reason: text(input.reason, 'justificação', 1000, false), selfApproval: false };
}
