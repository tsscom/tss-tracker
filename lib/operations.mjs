import { randomUUID } from 'node:crypto';
import { parsePrice } from '../public/domain.mjs';
import { fail, text, can, requirePermission } from './security.mjs';

export const OPERATIONAL_COLLECTIONS = ['vehicles', 'drivers', 'opportunities', 'activities', 'incidents', 'costs', 'attachments', 'mobileOperations'];
export const OPPORTUNITY_STAGES = ['Novo', 'Em contacto', 'Proposta', 'Negociação', 'Ganho', 'Perdido'];
export const INCIDENT_TYPES = ['delay', 'breakdown', 'accident', 'damage', 'other'];
export const INCIDENT_SEVERITIES = ['low', 'medium', 'high'];
export const COST_CATEGORIES = ['Combustível', 'Portagens', 'Subcontratação', 'Oficina', 'Outros'];
const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fold = value => String(value ?? '').trim().toLocaleLowerCase('pt-PT');
const event = (store, user, name, type, id, details = {}) => store.audit.push({ id: randomUUID(), at: now(), actorId: user?.id ?? null, actorName: user?.name ?? 'Sistema', actorRole: user?.role ?? 'sistema', event: name, entityType: type, entityId: id, details });
const base = user => { const at = now(); return { id: randomUUID(), createdBy: user.id, createdAt: at, updatedAt: at, version: 1 }; };
const update = item => { item.version++; item.updatedAt = now(); };
function find(store, key, id) { const item = store[key].find(row => row.id === id); if (!item) fail(404, 'O registo não existe. Atualize a página.'); return item; }
function checkVersion(item, input) { if (!Number.isSafeInteger(input.version) || input.version !== item.version) fail(409, 'O registo foi alterado. Atualize a página antes de guardar.'); }
function choice(value, options, label) { if (!options.includes(value)) fail(400, `Introduza um valor válido para ${label}.`); return value; }
function number(value, label, maximum = 10000000, integer = false, optional = true) {
  if (value == null || value === '') { if (optional) return null; fail(400, `Preencha ${label}.`); }
  if (typeof value !== 'number' && typeof value !== 'string') fail(400, `Introduza um número válido para ${label}.`);
  const normalized = typeof value === 'string' ? value.trim().replace(',', '.') : value;
  if (normalized === '') return optional ? null : fail(400, `Preencha ${label}.`);
  const result = Number(normalized);
  if (!Number.isFinite(result) || result < 0 || result > maximum || (integer && !Number.isSafeInteger(result))) fail(400, `Introduza um número válido para ${label}.`);
  return result;
}
function date(value, label, optional = true) {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, `Introduza uma data válida para ${label}.`);
  return value;
}
function money(value, label, positive = false) {
  if (typeof value !== 'number' && typeof value !== 'string') fail(400, `Introduza um valor em euros válido para ${label}.`);
  let cents; try { cents = parsePrice(value); } catch { fail(400, `Introduza um valor em euros válido para ${label}.`); }
  if (positive && cents <= 0) fail(400, `O valor de ${label} deve ser superior a zero.`);
  return cents;
}
function owner(store, id) {
  if (!id) return null;
  const user = find(store, 'users', id);
  if (!user.active || !['gerente', 'comercial'].includes(user.role)) fail(400, 'O responsável deve ser um gerente ou comercial ativo.');
  return user.id;
}
function jobScope(store, user, jobId) {
  const job = find(store, 'jobs', jobId);
  if (user.role === 'motorista' && job.driverUserId !== user.id) fail(403, 'Só pode consultar e executar serviços atribuídos a si.');
  return job;
}

export function ensureOperationalCollections(store) {
  let changed = false;
  for (const key of OPERATIONAL_COLLECTIONS) if (store[key] === undefined) { store[key] = []; changed = true; }
  return changed;
}
export function validateOperationalCollections(store) {
  ensureOperationalCollections(store);
  for (const key of OPERATIONAL_COLLECTIONS) {
    if (!Array.isArray(store[key])) throw new Error(`Coleção ${key} inválida. Os dados foram preservados.`);
    const ids = new Set();
    for (const item of store[key]) {
      if (!item || typeof item.id !== 'string' || ids.has(item.id)) throw new Error(`Registo ${key} inválido. Os dados foram preservados.`);
      ids.add(item.id);
      if (item.version == null) item.version = 1;
      if (!Number.isSafeInteger(item.version) || item.version < 1) throw new Error(`Versão ${key} inválida. Os dados foram preservados.`);
    }
  }
  for (const [key, field] of [['vehicles', 'registration'], ['drivers', 'userId']]) {
    const seen = new Set();
    for (const item of store[key]) {
      const value = item[field]; if (!value) continue;
      const normalized = field === 'registration' ? String(value).toUpperCase() : value;
      if (seen.has(normalized)) throw new Error(`A coleção ${key} contém uma associação duplicada. Os dados foram preservados.`);
      seen.add(normalized);
    }
  }
}

export function saveVehicle(store, user, input, id) {
  requirePermission(user, 'fleet.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'vehicles', id) : null;
  if (previous) checkVersion(previous, input);
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const registration = text(value('registration'), 'matrícula', 40).toUpperCase();
  if (store.vehicles.some(row => row.id !== id && row.registration === registration)) fail(409, 'Esta matrícula já está registada.');
  if (previous && registration !== previous.registration && store.jobs.some(job => (job.vehicleId === id || job.vehicle === previous.registration) && ['Agendado', 'Em curso'].includes(job.status))) fail(409, 'A matrícula está associada a serviços ativos. Preserve a matrícula ou conclua os serviços.');
  const values = { registration, make: text(value('make'), 'marca', 80, false), model: text(value('model'), 'modelo', 80, false), status: choice(value('status') ?? 'Disponível', ['Disponível', 'Indisponível'], 'disponibilidade'), capacityKg: number(value('capacityKg'), 'capacidade em kg'), capacityPallets: number(value('capacityPallets'), 'capacidade de paletes', 1000, true), inspectionDueDate: date(value('inspectionDueDate'), 'inspeção'), insuranceDueDate: date(value('insuranceDueDate'), 'seguro'), odometerKm: number(value('odometerKm'), 'quilometragem', 10000000, true), nextServiceDate: date(value('nextServiceDate'), 'próxima manutenção'), nextServiceKm: number(value('nextServiceKm'), 'quilometragem da próxima manutenção', 10000000, true), notes: text(value('notes'), 'observações', 2000, false) };
  const vehicle = previous ?? base(user);
  Object.assign(vehicle, values);
  if (previous) update(vehicle); else store.vehicles.push(vehicle);
  event(store, user, previous ? 'vehicle.update' : 'vehicle.create', 'vehicle', vehicle.id, { registration, status: vehicle.status });
  return { vehicle };
}
export function saveDriver(store, user, input, id) {
  requirePermission(user, 'drivers.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'drivers', id) : null;
  if (previous) checkVersion(previous, input);
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const userId = value('userId') || null;
  if (userId) {
    const account = find(store, 'users', userId);
    if (!account.active || account.role !== 'motorista') fail(400, 'Associe uma conta de motorista ativa.');
    if (store.drivers.some(row => row.id !== id && row.userId === userId)) fail(409, 'Esta conta já tem um perfil de motorista.');
  }
  if (previous && userId !== previous.userId && store.jobs.some(job => (job.driverId === id || (previous.userId && job.driverUserId === previous.userId)) && ['Agendado', 'Em curso'].includes(job.status))) fail(409, 'A conta está associada a serviços ativos. Preserve a associação ou conclua os serviços.');
  const driver = previous ?? base(user);
  Object.assign(driver, { name: text(value('name'), 'nome', 100), userId, phone: text(value('phone'), 'telefone', 40, false), licenseNumber: text(value('licenseNumber'), 'carta de condução', 80, false), licenseExpiryDate: date(value('licenseExpiryDate'), 'validade da carta'), status: choice(value('status') ?? 'Ativo', ['Ativo', 'Suspenso'], 'estado do motorista'), notes: text(value('notes'), 'observações', 2000, false) });
  if (previous) update(driver); else store.drivers.push(driver);
  event(store, user, previous ? 'driver.update' : 'driver.create', 'driver', driver.id, { userId, status: driver.status });
  return { driver };
}

export function registryAssignment(store, input, previous = {}) {
  ensureOperationalCollections(store);
  const vehicleId = input.vehicleId === undefined ? previous.vehicleId ?? null : input.vehicleId || null;
  const driverId = input.driverId === undefined ? previous.driverId ?? null : input.driverId || null;
  const result = { vehicleId, driverId };
  if (vehicleId) {
    const vehicle = find(store, 'vehicles', vehicleId);
    if (input.vehicle != null && input.vehicle !== '' && String(input.vehicle).toUpperCase() !== vehicle.registration) fail(400, 'A matrícula deve corresponder à viatura selecionada.');
    result.vehicle = vehicle.registration;
  }
  if (driverId) {
    const driver = find(store, 'drivers', driverId);
    if (input.driver != null && input.driver !== '' && input.driver !== driver.name) fail(400, 'O nome deve corresponder ao motorista selecionado.');
    if (input.driverUserId != null && (input.driverUserId || null) !== driver.userId) fail(400, 'A conta deve corresponder ao perfil de motorista selecionado.');
    result.driver = driver.name; result.driverUserId = driver.userId;
  }
  return result;
}

export function jobDetails(input, previous = {}) {
  const value = key => input[key] === undefined ? previous[key] : input[key];
  const pickupTime = text(value('pickupTime'), 'hora de recolha', 5, false);
  const deliveryTime = text(value('deliveryTime'), 'hora de entrega', 5, false);
  const validTime = time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  if ((pickupTime || deliveryTime) && (!validTime(pickupTime) || !validTime(deliveryTime))) fail(400, 'Preencha ambas as horas no formato HH:mm, ou deixe ambas em branco para dias completos.');
  const pickupDate = value('pickupDate'), deliveryDate = value('deliveryDate');
  if (pickupTime && `${deliveryDate}T${deliveryTime}` <= `${pickupDate}T${pickupTime}`) fail(400, 'A data e hora de entrega devem ser posteriores à recolha.');
  return { pickupTime, deliveryTime, cargo: text(value('cargo'), 'mercadoria', 500, false), weightKg: number(value('weightKg'), 'peso em kg'), pallets: number(value('pallets'), 'paletes', 1000, true), instructions: text(value('instructions'), 'instruções', 2000, false) };
}
function windowFor(job) {
  if (job.pickupTime && job.deliveryTime) return [`${job.pickupDate}T${job.pickupTime}`, `${job.deliveryDate}T${job.deliveryTime}`];
  const nextDay = new Date(Date.parse(job.deliveryDate + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return [`${job.pickupDate}T00:00`, `${nextDay}T00:00`];
}
export function jobsOverlap(first, second) {
  const [start, end] = windowFor(first), [otherStart, otherEnd] = windowFor(second);
  return start < otherEnd && otherStart < end;
}
export function resourceConflict(store, job) {
  return store.jobs.some(other => other.id !== job.id && ['Agendado', 'Em curso'].includes(other.status) && (other.dispatchedAt || other.status === 'Em curso') && jobsOverlap(job, other) && ((job.vehicle && other.vehicle === job.vehicle) || (job.driverId && other.driverId === job.driverId) || (job.driverUserId && other.driverUserId === job.driverUserId) || (!(job.driverId || job.driverUserId) || !(other.driverId || other.driverUserId)) && job.driver && other.driver && fold(job.driver) === fold(other.driver)));
}
export function registryBlockers(store, job) {
  ensureOperationalCollections(store);
  const blockers = [];
  const vehicle = job.vehicleId ? store.vehicles.find(row => row.id === job.vehicleId) : store.vehicles.find(row => row.registration === job.vehicle);
  const driver = job.driverId ? store.drivers.find(row => row.id === job.driverId) : store.drivers.find(row => row.userId && row.userId === job.driverUserId);
  const until = job.deliveryDate > today() ? job.deliveryDate : today();
  if (job.vehicleId && (!vehicle || vehicle.registration !== job.vehicle)) blockers.push({ code: 'vehicle_registry_mismatch', label: 'A viatura atribuída já não corresponde ao registo da frota.' });
  if (vehicle?.status === 'Indisponível') blockers.push({ code: 'vehicle_unavailable', label: 'A viatura está marcada como indisponível.' });
  for (const [key, code, label] of [['inspectionDueDate', 'inspection_expired', 'Inspeção da viatura caducada antes do fim do serviço.'], ['insuranceDueDate', 'insurance_expired', 'Seguro da viatura caducado antes do fim do serviço.']]) if (vehicle?.[key] && vehicle[key] < until) blockers.push({ code, label });
  if (vehicle?.capacityKg != null && job.weightKg != null && job.weightKg > vehicle.capacityKg) blockers.push({ code: 'weight_capacity', label: 'O peso da mercadoria excede a capacidade registada da viatura.' });
  if (vehicle?.capacityPallets != null && job.pallets != null && job.pallets > vehicle.capacityPallets) blockers.push({ code: 'pallet_capacity', label: 'As paletes excedem a capacidade registada da viatura.' });
  if (job.driverId && (!driver || (driver.userId || null) !== (job.driverUserId || null))) blockers.push({ code: 'driver_registry_mismatch', label: 'A conta de motorista já não corresponde ao perfil atribuído.' });
  if (driver?.status === 'Suspenso') blockers.push({ code: 'driver_suspended', label: 'O perfil do motorista está suspenso.' });
  if (driver?.licenseExpiryDate && driver.licenseExpiryDate < until) blockers.push({ code: 'license_expired', label: 'A carta de condução caduca antes do fim do serviço.' });
  return blockers;
}

export function saveOpportunity(store, user, input, id) {
  requirePermission(user, 'sales.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'opportunities', id) : null;
  if (previous) { checkVersion(previous, input); if (['Ganho', 'Perdido'].includes(previous.status)) fail(409, 'Uma oportunidade encerrada está bloqueada. Crie uma nova oportunidade.'); }
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const customer = find(store, 'customers', value('customerId'));
  if (input.status !== undefined && input.status !== (previous?.status ?? 'Novo')) fail(409, 'Altere a fase através da ação comercial autorizada.');
  const opportunity = previous ?? base(user);
  const expectedValueCents = input.expectedValue === undefined ? previous?.expectedValueCents ?? 0 : money(input.expectedValue, 'valor previsto');
  Object.assign(opportunity, { customerId: customer.id, customer: customer.name, title: text(value('title'), 'oportunidade', 180), expectedValueCents, nextFollowUpDate: date(value('nextFollowUpDate'), 'próximo contacto'), ownerId: owner(store, value('ownerId') ?? user.id), notes: text(value('notes'), 'observações', 2000, false), status: previous?.status ?? 'Novo' });
  if (previous) update(opportunity); else store.opportunities.push(opportunity);
  event(store, user, previous ? 'opportunity.update' : 'opportunity.create', 'opportunity', opportunity.id, { status: opportunity.status });
  return { opportunity };
}
export function saveActivity(store, user, input, id) {
  requirePermission(user, 'sales.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'activities', id) : null;
  if (previous) checkVersion(previous, input);
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const opportunity = find(store, 'opportunities', value('opportunityId'));
  if (['Ganho', 'Perdido'].includes(opportunity.status)) fail(409, 'A oportunidade está encerrada.');
  const activity = previous ?? base(user);
  Object.assign(activity, { opportunityId: opportunity.id, customerId: opportunity.customerId, type: choice(value('type') ?? 'Nota', ['Chamada', 'Email', 'Reunião', 'Nota'], 'tipo de atividade'), description: text(value('description'), 'atividade', 2000), dueDate: date(value('dueDate'), 'data do contacto'), completedAt: previous?.completedAt ?? null });
  if (input.completed !== undefined) { if (typeof input.completed !== 'boolean') fail(400, 'O estado da atividade é inválido.'); activity.completedAt = input.completed ? activity.completedAt ?? now() : null; }
  if (previous) update(activity); else store.activities.push(activity);
  event(store, user, previous ? 'activity.update' : 'activity.create', 'activity', activity.id, { opportunityId: opportunity.id, completed: !!activity.completedAt });
  return { activity };
}
export function opportunityAction(store, user, id, input) {
  requirePermission(user, 'sales.write'); ensureOperationalCollections(store);
  const opportunity = find(store, 'opportunities', id); checkVersion(opportunity, input);
  if (['Ganho', 'Perdido'].includes(opportunity.status)) fail(409, 'A oportunidade está encerrada.');
  if (input.action === 'activity') {
    const result = saveActivity(store, user, { ...input, opportunityId: id });
    if (input.nextFollowUpDate !== undefined) opportunity.nextFollowUpDate = date(input.nextFollowUpDate, 'próximo contacto');
    update(opportunity); return { opportunity, ...result };
  }
  if (input.action !== 'stage') fail(400, 'Ação comercial desconhecida.');
  const status = choice(input.status, OPPORTUNITY_STAGES, 'fase comercial');
  if (status === opportunity.status) fail(409, 'A oportunidade já está nesta fase.');
  const reason = text(input.reason, 'observação da mudança de fase', 2000, ['Ganho', 'Perdido'].includes(status));
  const before = opportunity.status;
  opportunity.status = status; opportunity.stageReason = reason;
  if (['Ganho', 'Perdido'].includes(status)) { opportunity.closedAt = now(); opportunity.closedBy = user.id; }
  update(opportunity); event(store, user, 'opportunity.stage', 'opportunity', id, { before, after: status, reason });
  return { opportunity };
}

export function saveCost(store, user, input, id) {
  requirePermission(user, 'costs.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'costs', id) : null;
  if (previous) checkVersion(previous, input);
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const job = find(store, 'jobs', value('jobId'));
  const amountCents = input.amount === undefined && previous ? previous.amountCents : money(input.amount, 'custo', true);
  const values = { jobId: job.id, category: choice(value('category'), COST_CATEGORIES, 'categoria'), amountCents, date: date(value('date') ?? today(), 'custo', false), supplier: text(value('supplier'), 'fornecedor', 180, false), reference: text(value('reference'), 'referência', 180), notes: text(value('notes'), 'observações', 2000, false) };
  if (values.date > today()) fail(400, 'Um custo efetivo não pode ter uma data futura.');
  if (store.costs.some(row => row.id !== id && fold(row.reference) === fold(values.reference) && fold(row.supplier) === fold(values.supplier) && row.category === values.category)) fail(409, 'Este custo já foi registado para o fornecedor, categoria e referência.');
  if (previous && text(input.reason, 'motivo da correção do custo', 1000).length < 10) fail(400, 'A correção de um custo exige uma justificação de pelo menos 10 caracteres.');
  const cost = previous ?? base(user); const prior = previous ? { amountCents: previous.amountCents, jobId: previous.jobId, reference: previous.reference } : null;
  Object.assign(cost, values); if (previous) update(cost); else store.costs.push(cost);
  event(store, user, previous ? 'cost.update' : 'cost.create', 'cost', cost.id, { before: prior, amountCents, jobId: job.id, reason: input.reason ?? '' });
  return { cost };
}
export function saveIncident(store, user, input, id) {
  requirePermission(user, 'incidents.write'); ensureOperationalCollections(store);
  const previous = id ? find(store, 'incidents', id) : null;
  if (previous) {
    checkVersion(previous, input); jobScope(store, user, previous.jobId);
    if (previous.status !== 'Aberta') fail(409, 'Uma incidência em tratamento está bloqueada para edição.');
    if (user.role === 'motorista' && previous.createdBy !== user.id) fail(403, 'Só pode editar incidências comunicadas por si.');
  }
  const value = key => input[key] === undefined ? previous?.[key] : input[key];
  const job = jobScope(store, user, value('jobId'));
  if (previous && job.id !== previous.jobId) fail(409, 'O serviço de uma incidência está bloqueado.');
  const description = text(value('description'), 'descrição da incidência', 2000);
  if (description.length < 10) fail(400, 'Descreva a incidência com pelo menos 10 caracteres.');
  const incident = previous ?? base(user);
  Object.assign(incident, { jobId: job.id, type: choice(value('type') ?? 'other', INCIDENT_TYPES, 'tipo de incidência'), severity: choice(value('severity') ?? 'medium', INCIDENT_SEVERITIES, 'gravidade'), description, status: previous?.status ?? 'Aberta' });
  if (previous) update(incident); else store.incidents.push(incident);
  event(store, user, previous ? 'incident.update' : 'incident.create', 'incident', incident.id, { jobId: job.id, type: incident.type, severity: incident.severity });
  return { incident };
}
export function incidentAction(store, user, id, input) {
  requirePermission(user, 'incidents.resolve'); ensureOperationalCollections(store);
  const incident = find(store, 'incidents', id); checkVersion(incident, input);
  const before = incident.status;
  if (input.action === 'investigate' && incident.status === 'Aberta') { incident.status = 'Em análise'; incident.assignedTo = user.id; }
  else if (input.action === 'resolve' && ['Aberta', 'Em análise'].includes(incident.status)) {
    const resolution = text(input.resolution ?? input.reason, 'resolução', 2000);
    if (resolution.length < 10) fail(400, 'Registe uma resolução com pelo menos 10 caracteres.');
    Object.assign(incident, { status: 'Resolvida', resolution, resolvedBy: user.id, resolvedAt: now() });
  } else fail(409, 'A ação não é permitida no estado atual da incidência.');
  update(incident); event(store, user, `incident.${input.action}`, 'incident', id, { before, after: incident.status, resolution: incident.resolution ?? '' });
  return { incident };
}

export function operationalWorkspace(store, user) {
  ensureOperationalCollections(store);
  const visibleJobs = store.jobs.filter(job => can(user, 'jobs.read') && (user.role !== 'motorista' || job.driverUserId === user.id));
  const jobIds = new Set(visibleJobs.map(job => job.id));
  const result = { vehicles: can(user, 'fleet.read') ? structuredClone(store.vehicles) : [], drivers: can(user, 'drivers.read') ? structuredClone(store.drivers.filter(driver => user.role !== 'motorista' || driver.userId === user.id)) : [], opportunities: can(user, 'sales.read') ? structuredClone(store.opportunities) : [], activities: can(user, 'sales.read') ? structuredClone(store.activities) : [], costs: can(user, 'costs.read') ? structuredClone(store.costs) : [], incidents: can(user, 'incidents.read') ? structuredClone(store.incidents.filter(incident => jobIds.has(incident.jobId))) : [], attachments: can(user, 'documents.read') ? store.attachments.filter(attachment => jobIds.has(attachment.jobId)).map(({ storageKey, ...attachment }) => structuredClone(attachment)) : [] };
  if (can(user, 'costs.read')) result.contributions = visibleJobs.map(job => {
    const costs = store.costs.filter(cost => cost.jobId === job.id);
    const costCents = costs.reduce((sum, cost) => sum + cost.amountCents, 0);
    const revenueCents = job.status === 'Cancelado' ? 0 : job.priceCents;
    return { jobId: job.id, reference: job.reference, status: job.status, revenueCents, costCents, contributionCents: revenueCents - costCents, costCount: costs.length };
  });
  if (can(user, 'dashboard.read')) {
    const registryAlerts = [];
    const maintenanceDue = [];
    for (const vehicle of store.vehicles) {
      for (const [key, label] of [['inspectionDueDate', 'Inspeção'], ['insuranceDueDate', 'Seguro']]) if (vehicle[key] && vehicle[key] < today()) registryAlerts.push({ type: 'vehicle', entityId: vehicle.id, label: vehicle.registration, reason: `${label} caducado` });
      if (vehicle.status === 'Indisponível') registryAlerts.push({ type: 'vehicle', entityId: vehicle.id, label: vehicle.registration, reason: 'Viatura indisponível' });
      if ((vehicle.nextServiceDate && vehicle.nextServiceDate <= today()) || (vehicle.nextServiceKm != null && vehicle.odometerKm != null && vehicle.odometerKm >= vehicle.nextServiceKm)) maintenanceDue.push({ vehicleId: vehicle.id, registration: vehicle.registration, nextServiceDate: vehicle.nextServiceDate, nextServiceKm: vehicle.nextServiceKm, odometerKm: vehicle.odometerKm });
    }
    for (const driver of store.drivers) if (driver.status === 'Suspenso' || (driver.licenseExpiryDate && driver.licenseExpiryDate < today())) registryAlerts.push({ type: 'driver', entityId: driver.id, label: driver.name, reason: driver.status === 'Suspenso' ? 'Motorista suspenso' : 'Carta caducada' });
    const overdue = store.invoices.filter(invoice => invoice.status === 'Emitida' && invoice.dueDate < today());
    const pending = ['quotes', 'workOrders', 'invoices'].reduce((sum, key) => sum + store[key].filter(row => row.status === 'Em aprovação').length, 0) + store.jobs.filter(job => job.cancelRequest?.status === 'Em aprovação').length + store.customers.filter(customer => customer.creditRequest?.status === 'Em aprovação').length;
    result.managerDashboard = { pendingApprovals: pending, overdueInvoices: overdue.length, overdueAmountCents: overdue.reduce((sum, invoice) => sum + invoice.amountCents - invoice.payments.reduce((paid, payment) => paid + payment.amountCents, 0), 0), followUpsDue: store.opportunities.filter(opportunity => !['Ganho', 'Perdido'].includes(opportunity.status) && opportunity.nextFollowUpDate && opportunity.nextFollowUpDate <= today()).length + store.activities.filter(activity => !activity.completedAt && activity.dueDate && activity.dueDate <= today() && !['Ganho', 'Perdido'].includes(store.opportunities.find(opportunity => opportunity.id === activity.opportunityId)?.status)).length, openIncidents: store.incidents.filter(incident => incident.status !== 'Resolvida').length, missingAssignments: store.jobs.filter(job => job.status === 'Agendado' && (!job.driver || !job.vehicle)).length, missingPod: store.jobs.filter(job => job.status === 'Concluído' && !job.pod).length, registryAlerts, maintenanceDue };
  }
  return result;
}
