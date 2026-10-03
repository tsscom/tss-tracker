import { randomUUID } from 'node:crypto';
import { normalizeJob, parsePrice } from '../public/domain.mjs';
import { fail, text, can, requirePermission, permissionsFor, ROLES, publicUser, username, hashPassword, approval } from './security.mjs';
import { workflowView, invoiceDueDate } from './workflows.mjs';
import { operationalWorkspace, registryAssignment, registryBlockers, jobDetails, resourceConflict } from './operations.mjs';

const now = () => new Date().toISOString();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, `Introduza uma data válida para ${label}.`);
  return value;
}
function money(value, positive = false) {
  let cents;
  try { cents = parsePrice(value); } catch (error) { fail(400, error.message); }
  if (positive && cents <= 0) fail(400, 'O valor deve ser superior a zero.');
  return cents;
}
function find(store, collection, id) {
  const value = store[collection].find(item => item.id === id);
  if (!value) fail(404, 'O registo não existe. Atualize a lista.');
  return value;
}
function state(item, allowed) { if (!allowed.includes(item.status)) fail(409, 'Esta ação não é permitida no estado atual.'); }
function updated(item) { item.updatedAt = now(); item.version = (item.version ?? 0) + 1; }
function version(item, input) { if (!Number.isSafeInteger(input.version) || input.version !== item.version) fail(409, 'Este registo foi alterado ou falta a versão atual. Atualize a lista antes de guardar ou aprovar.'); }
function ref(store, key, prefix) { return `${prefix}-${String(store.counters[key]++).padStart(4, '0')}`; }
export function audit(store, user, event, entityType, entityId, details = {}) {
  store.audit.push({ id: randomUUID(), at: now(), actorId: user?.id ?? null, actorName: user?.name ?? 'Sistema', actorRole: user?.role ?? 'sistema', event, entityType, entityId, details });
}
function base(user) { const at = now(); return { id: randomUUID(), createdBy: user.id, createdAt: at, updatedAt: at, version: 1 }; }
function assignment(store, input, previous = {}) {
  const registry = registryAssignment(store, input, previous);
  const values = { ...input, ...registry };
  const driverUserId = values.driverUserId === undefined ? previous.driverUserId ?? null : values.driverUserId || null;
  let driver = values.driver === undefined ? previous.driver ?? '' : text(values.driver, 'motorista', 100, false);
  if (driverUserId) {
    const user = find(store, 'users', driverUserId);
    if (!user.active || user.role !== 'motorista') fail(400, 'Associe um utilizador motorista ativo.');
    if (!registry.driverId) driver = user.name;
  }
  return { ...registry, driverUserId, driver, vehicle: text(values.vehicle === undefined ? previous.vehicle : values.vehicle, 'viatura', 40, false).toUpperCase() };
}
export function jobPayment(store, job) {
  const invoice = store.invoices.find(item => item.jobId === job.id && ['Emitida', 'Paga'].includes(item.status));
  if (!invoice) return 'Pendente';
  const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  if (paid === invoice.amountCents) return 'Pago';
  if (paid > 0) return 'Parcial';
  return invoice.dueDate < today() ? 'Em atraso' : 'Pendente';
}
function scopeJob(user, job) { if (user.role === 'motorista' && job.driverUserId !== user.id) fail(403, 'Só pode consultar e executar serviços atribuídos a si.'); }
const operationalRoles = ['motorista', 'parque', 'oficina'];
function visibleJob(store, user, job) {
  const result = { ...job, paymentStatus: jobPayment(store, job), dispatchReadiness: dispatchReadiness(store, job) };
  if (operationalRoles.includes(user.role)) {
    for (const key of ['priceCents', 'quotedPrice', 'paymentStatus', 'legacyPaymentStatus', 'quoteId', 'cancelRequest', 'automation']) delete result[key];
  }
  return result;
}
function operationalOrder(user, order) {
  const result = structuredClone(order);
  if (['parque', 'operacoes'].includes(user.role)) for (const key of ['estimatedCostCents', 'actualCostCents', 'approval', 'releaseApproval']) delete result[key];
  return result;
}
export function workspace(store, user) {
  const permission = permissionsFor(user);
  const jobs = can(user, 'jobs.read') ? store.jobs.filter(job => user.role !== 'motorista' || job.driverUserId === user.id).map(job => visibleJob(store, user, job)) : [];
  const customers = can(user, 'customers.read') ? store.customers.map(customer => {
    const result = structuredClone(customer);
    if (user.role === 'operacoes') { delete result.creditLimitCents; delete result.creditRequest; }
    return result;
  }) : [];
  const quotes = can(user, 'quotes.read') ? store.quotes : [];
  const invoices = can(user, 'invoices.read') ? store.invoices : [];
  const workOrders = can(user, 'workshop.read') ? store.workOrders.map(order => operationalOrder(user, order)) : [];
  const approvals = [];
  function pending(items, type, amountKey) {
    for (const item of items.filter(item => item.status === 'Em aprovação')) approvals.push({ id: `${type}:${item.id}`, type, entityId: item.id, reference: item.reference, requestedBy: item.submittedBy, requestedByName: store.users.find(value => value.id === item.submittedBy)?.name ?? 'Utilizador', amountCents: item[amountKey], label: type === 'quote' ? item.customer : type === 'invoice' ? item.customer : item.vehicle });
  }
  pending(quotes, 'quote', 'priceCents'); pending(invoices, 'invoice', 'amountCents'); pending(workOrders, 'workOrder', 'estimatedCostCents');
  for (const job of jobs) if (job.cancelRequest?.status === 'Em aprovação') approvals.push({ id: `cancel:${job.id}`, type: 'cancel', entityId: job.id, reference: job.reference, requestedBy: job.cancelRequest.requestedBy, requestedByName: store.users.find(value => value.id === job.cancelRequest.requestedBy)?.name ?? 'Utilizador', label: job.customer });
  for (const customer of customers) if (customer.creditRequest?.status === 'Em aprovação') approvals.push({ id: `credit:${customer.id}`, type: 'credit', entityId: customer.id, reference: customer.name, requestedBy: customer.creditRequest.requestedBy, requestedByName: store.users.find(value => value.id === customer.creditRequest.requestedBy)?.name ?? 'Utilizador', amountCents: customer.creditRequest.creditLimitCents, label: customer.name });
  const visibleAudit = user.role === 'administrador' ? store.audit.filter(event => /^(security\.|user\.|migration\.)/.test(event.event)) : store.audit;
  const result = { user: publicUser(user), permissions: permission, roles: ROLES, jobs, customers, quotes, yard: can(user, 'yard.read') ? store.yard : [], workOrders, invoices, approvals, audit: can(user, 'audit.read') ? visibleAudit.slice(-500).reverse() : [], staff: store.users.filter(value => value.active && (user.role !== 'motorista' || value.id === user.id) && user.role !== 'administrador').map(value => ({ id: value.id, name: value.name, role: value.role, active: value.active })) };
  if (can(user, 'users.read')) result.users = store.users.map(publicUser);
  if (user.role === 'gerente' || user.role === 'auditor') result.migration = store.migration;
  const configuration = store.workflowConfiguration;
  result.workflowPolicy = {};
  if (can(user, 'quotes.read')) result.workflowPolicy.quoteAcceptedToJob = configuration.rules.quoteAcceptedToJob;
  if (can(user, 'invoices.read')) Object.assign(result.workflowPolicy, { version: configuration.version, deliveryToInvoiceDraft: configuration.rules.deliveryToInvoiceDraft, invoiceApprovedToIssued: configuration.rules.invoiceApprovedToIssued, invoiceDueDays: configuration.invoiceDueDays });
  if (can(user, 'workflows.read')) result.workflows = workflowView(store, user);
  Object.assign(result, operationalWorkspace(store, user));
  return result;
}
export function scopedJobs(store, user) { requirePermission(user, 'jobs.read'); return workspace(store, user).jobs; }

export function saveCustomer(store, user, input, id) {
  requirePermission(user, 'customers.write');
  let customer = id ? find(store, 'customers', id) : null;
  if (customer) version(customer, input);
  if (input.creditLimit != null && money(input.creditLimit) !== (customer?.creditLimitCents ?? 0)) fail(409, 'Alterações ao limite de crédito exigem um pedido e aprovação do gerente.');
  if (input.creditLimitCents != null && input.creditLimitCents !== (customer?.creditLimitCents ?? 0)) fail(409, 'Alterações ao limite de crédito exigem aprovação.');
  const values = {};
  for (const [key, label, max] of [['name', 'nome', 120], ['taxId', 'NIF', 30], ['contact', 'contacto', 120], ['email', 'email', 180], ['phone', 'telefone', 40]]) values[key] = text(input[key] ?? customer?.[key], label, max, key === 'name');
  if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fail(400, 'Introduza um email válido.');
  if (customer && values.taxId !== customer.taxId && (customer.creditLimitCents > 0 || customer.creditRequest?.status === 'Em aprovação' || store.quotes.some(quote => quote.customerId === customer.id && !['Rascunho', 'Rejeitada'].includes(quote.status)) || store.invoices.some(invoice => invoice.customerId === customer.id))) fail(409, 'O NIF está bloqueado por crédito ou documentos comerciais aprovados. Crie um novo cliente para outra entidade legal.');
  if (values.taxId && store.customers.some(value => value.id !== id && value.taxId === values.taxId)) fail(409, 'Já existe um cliente com este NIF.');
  const ownerId = input.ownerId === undefined ? customer?.ownerId ?? null : input.ownerId || null;
  if (ownerId) { const owner = find(store, 'users', ownerId); if (!owner.active || !['gerente', 'comercial'].includes(owner.role)) fail(400, 'O responsável comercial deve ser um comercial ou gerente ativo.'); }
  if (!customer) { customer = { ...base(user), ...values, ownerId, creditLimitCents: 0, sample: false }; store.customers.push(customer); }
  else { Object.assign(customer, values, { ownerId, sample: false }); updated(customer); }
  audit(store, user, id ? 'customer.update' : 'customer.create', 'customer', customer.id);
  return { customer };
}
export function customerAction(store, user, id, input) {
  requirePermission(user, input.action === 'requestCredit' ? 'customers.write' : 'customers.credit');
  const customer = find(store, 'customers', id); version(customer, input);
  if (input.action === 'requestCredit') {
    requirePermission(user, 'customers.write');
    if (customer.creditRequest?.status === 'Em aprovação') fail(409, 'Já existe um pedido de crédito pendente.');
    customer.creditRequest = { id: randomUUID(), previousCreditLimitCents: customer.creditLimitCents, creditLimitCents: money(input.creditLimit), requestedBy: user.id, requestedAt: now(), reason: text(input.reason, 'motivo', 1000), status: 'Em aprovação' };
  } else if (['approveCredit', 'rejectCredit'].includes(input.action)) {
    requirePermission(user, 'customers.credit');
    if (customer.creditRequest?.status !== 'Em aprovação') fail(409, 'Não existe um pedido de crédito pendente.');
    if (input.action === 'approveCredit') {
      customer.creditRequest.approval = approval(user, [customer.creditRequest.requestedBy], input);
      customer.creditLimitCents = customer.creditRequest.creditLimitCents;
      customer.creditRequest.status = 'Aprovado';
    } else { customer.creditRequest.status = 'Rejeitado'; customer.creditRequest.rejectionReason = text(input.reason, 'motivo da rejeição', 1000); }
    customer.creditRequest.decidedBy = user.id; customer.creditRequest.decidedAt = now();
  } else fail(400, 'Ação de cliente desconhecida.');
  updated(customer); audit(store, user, `customer.${input.action}`, 'customer', id, { ...customer.creditRequest, ...(input.action === 'approveCredit' ? customer.creditRequest.approval : {}) });
  return { customer };
}
export function createQuote(store, user, input) {
  requirePermission(user, 'quotes.write');
  const customer = find(store, 'customers', input.customerId);
  const normalized = normalizeJob({ customer: customer.name, pickup: input.pickup, delivery: input.delivery, pickupDate: input.pickupDate, deliveryDate: input.deliveryDate, quotedPrice: input.quotedPrice, driver: '', vehicle: '', status: 'Agendado', paymentStatus: 'Pendente' });
  if (normalized.priceCents <= 0) fail(400, 'O preço do orçamento deve ser superior a zero.');
  const quote = { ...base(user), reference: ref(store, 'quotes', 'ORC'), customerId: customer.id, customer: customer.name, pickup: normalized.pickup, delivery: normalized.delivery, pickupDate: normalized.pickupDate, deliveryDate: normalized.deliveryDate, priceCents: normalized.priceCents, status: 'Rascunho' };
  store.quotes.push(quote); audit(store, user, 'quote.create', 'quote', quote.id);
  return { quote };
}
export function saveQuote(store, user, id, input) {
  requirePermission(user, 'quotes.write');
  const quote = find(store, 'quotes', id); version(quote, input); state(quote, ['Rascunho', 'Rejeitada']);
  const customer = find(store, 'customers', input.customerId ?? quote.customerId);
  const normalized = normalizeJob({ customer: customer.name, pickup: input.pickup ?? quote.pickup, delivery: input.delivery ?? quote.delivery, pickupDate: input.pickupDate ?? quote.pickupDate, deliveryDate: input.deliveryDate ?? quote.deliveryDate, quotedPrice: input.quotedPrice ?? (quote.priceCents / 100).toFixed(2), driver: '', vehicle: '', status: 'Agendado', paymentStatus: 'Pendente' });
  if (normalized.priceCents <= 0) fail(400, 'O preço do orçamento deve ser superior a zero.');
  Object.assign(quote, { customerId: customer.id, customer: customer.name, pickup: normalized.pickup, delivery: normalized.delivery, pickupDate: normalized.pickupDate, deliveryDate: normalized.deliveryDate, priceCents: normalized.priceCents, status: 'Rascunho' });
  updated(quote); audit(store, user, 'quote.update', 'quote', id);
  return { quote };
}
export function quoteAction(store, user, id, input) {
  requirePermission(user, input.action === 'convert' ? 'jobs.plan' : input.action === 'accept' ? 'quotes.accept' : ['approve', 'reject'].includes(input.action) ? 'quotes.approve' : 'quotes.write');
  const quote = find(store, 'quotes', id); version(quote, input);
  if (input.action === 'submit') {
    requirePermission(user, 'quotes.write'); state(quote, ['Rascunho', 'Rejeitada']);
    quote.status = 'Em aprovação'; quote.submittedBy = user.id; quote.submittedAt = now();
  } else if (input.action === 'approve') {
    requirePermission(user, 'quotes.approve'); state(quote, ['Em aprovação']);
    quote.approval = approval(user, [quote.createdBy, quote.submittedBy], input);
    quote.status = 'Aprovada'; quote.approvedBy = user.id; quote.approvedAt = now();
  } else if (input.action === 'reject') {
    requirePermission(user, 'quotes.approve'); state(quote, ['Em aprovação']);
    quote.status = 'Rejeitada'; quote.rejectionReason = text(input.reason, 'motivo da rejeição', 1000); quote.rejectedBy = user.id;
  } else if (input.action === 'accept') {
    requirePermission(user, 'quotes.accept'); state(quote, ['Aprovada']);
    quote.acceptanceReference = text(input.acceptanceReference, 'referência da aceitação do cliente', 180);
    if (quote.acceptanceReference.length < 3) fail(400, 'Registe uma referência de aceitação do cliente com pelo menos 3 caracteres.');
    quote.status = 'Aceite'; quote.acceptedBy = user.id; quote.acceptedAt = now();
  } else if (input.action === 'convert') return convertQuote(store, user, quote, input);
  else fail(400, 'Ação de orçamento desconhecida.');
  updated(quote); audit(store, user, `quote.${input.action}`, 'quote', id, quote.approval ?? { reason: input.reason ?? '' });
  const automated = input.action === 'accept' ? runAutomations(store, user, 'quote.accept', { quote }, input) : {};
  return { quote, ...automated };
}
function convertQuote(store, user, quote, input) {
  requirePermission(user, 'jobs.plan'); version(quote, input); state(quote, ['Aceite']);
  if (quote.jobId || store.jobs.some(job => job.quoteId === quote.id)) fail(409, 'Já existe um serviço para este orçamento. Atualize a lista.');
  const job = { ...base(user), reference: `TSS-${String(store.nextNumber++).padStart(4, '0')}`, customerId: quote.customerId, customer: quote.customer, pickup: quote.pickup, delivery: quote.delivery, pickupDate: quote.pickupDate, deliveryDate: quote.deliveryDate, priceCents: quote.priceCents, status: 'Agendado', paymentStatus: 'Pendente', ...assignment(store, input), ...jobDetails({ ...input, pickupDate: quote.pickupDate, deliveryDate: quote.deliveryDate }), quoteId: quote.id, sample: false, pod: null };
  quote.status = 'Convertida'; quote.jobId = job.id; updated(quote);
  store.jobs.push(job); audit(store, user, 'quote.convert', 'job', job.id, { quoteId: quote.id });
  return { job, quote };
}
export function createJob(store, user, input) {
  requirePermission(user, 'jobs.plan');
  if (!input.quoteId) fail(409, 'Crie o serviço a partir de um orçamento aprovado e aceite pelo cliente.');
  return convertQuote(store, user, find(store, 'quotes', input.quoteId), input);
}
export function saveJob(store, user, id, input) {
  requirePermission(user, 'jobs.plan');
  const job = find(store, 'jobs', id); version(job, input);
  if (job.status !== 'Agendado' || job.dispatchedAt || job.cancelRequest?.status === 'Em aprovação') fail(409, 'Só pode alterar o planeamento antes da autorização de saída e sem cancelamento pendente.');
  if ((input.status != null && input.status !== job.status) || (input.paymentStatus != null && input.paymentStatus !== jobPayment(store, job))) fail(409, 'Os estados de serviço e pagamento só mudam através das ações autorizadas.');
  for (const key of ['customer', 'customerId', 'pickup', 'delivery', 'quoteId']) if (input[key] != null && input[key] !== job[key]) fail(409, 'Os dados comerciais aprovados estão bloqueados. Crie um novo orçamento para alterar cliente, percurso ou preço.');
  if ((input.quotedPrice != null && money(input.quotedPrice) !== job.priceCents) || (input.priceCents != null && input.priceCents !== job.priceCents)) fail(409, 'O preço aprovado está bloqueado.');
  const pickupDate = date(input.pickupDate ?? job.pickupDate, 'recolha'), deliveryDate = date(input.deliveryDate ?? job.deliveryDate, 'entrega');
  if (deliveryDate < pickupDate) fail(400, 'A entrega não pode ser anterior à recolha.');
  const details = jobDetails({ ...input, pickupDate, deliveryDate }, job);
  Object.assign(job, assignment(store, input, job), details, { pickupDate, deliveryDate }); updated(job);
  audit(store, user, 'job.plan', 'job', id, { driverUserId: job.driverUserId, driverId: job.driverId, vehicleId: job.vehicleId, vehicle: job.vehicle, pickupDate, deliveryDate, pickupTime: job.pickupTime, deliveryTime: job.deliveryTime });
  return { job: visibleJob(store, user, job) };
}
function blockVehicle(store, vehicle) {
  if (store.workOrders.some(order => order.vehicle === vehicle && !['Rejeitada', 'Libertada'].includes(order.status))) fail(409, 'A viatura está bloqueada por uma ordem de oficina ainda não libertada.');
}
export function dispatchReadiness(store, job) {
  if (job.status !== 'Agendado') return { state: 'Não aplicável', ready: false, blockers: [] };
  const blockers = [];
  if (job.cancelRequest?.status === 'Em aprovação') blockers.push({ code: 'pending_cancellation', label: 'Cancelamento pendente de decisão do gerente.' });
  if (!job.driver) blockers.push({ code: 'missing_driver', label: 'Motorista por atribuir.' });
  if (!job.vehicle) blockers.push({ code: 'missing_vehicle', label: 'Viatura por atribuir.' });
  if (job.driverUserId) {
    const driver = store.users.find(user => user.id === job.driverUserId);
    if (!driver?.active || driver.role !== 'motorista') blockers.push({ code: 'inactive_driver', label: 'O motorista associado não é um motorista ativo.' });
  }
  if (job.vehicle && store.workOrders.some(order => order.vehicle === job.vehicle && !['Rejeitada', 'Libertada'].includes(order.status))) blockers.push({ code: 'workshop_block', label: 'Intervenção de oficina por libertar pelo gerente.' });
  if (job.vehicle && store.yard.some(record => record.vehicle === job.vehicle && !record.checkedOutAt)) blockers.push({ code: 'yard_presence', label: 'Saída do parque por registar.' });
  blockers.push(...registryBlockers(store, job));
  if (resourceConflict(store, job)) blockers.push({ code: 'resource_overlap', label: 'Viatura ou motorista com serviço sobreposto na mesma janela de tempo.' });
  return { state: blockers.length ? 'Bloqueado' : 'Pronto', ready: blockers.length === 0, blockers };
}
function pod(input, store, job) {
  if (!input.pod || typeof input.pod !== 'object') fail(400, 'Registe o comprovativo de entrega (POD).');
  const deliveredAt = input.pod.deliveredAt ?? now();
  if (typeof deliveredAt !== 'string' || Number.isNaN(Date.parse(deliveredAt))) fail(400, 'Data/hora do comprovativo inválida.');
  const result = { recipient: text(input.pod.recipient, 'destinatário', 120), reference: text(input.pod.reference, 'referência do comprovativo', 180), deliveredAt: new Date(deliveredAt).toISOString() };
  if (input.pod.attachmentIds !== undefined) {
    const ids = input.pod.attachmentIds;
    if (!Array.isArray(ids) || ids.length > 12 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !store.attachments?.some(attachment => attachment.id === id && attachment.jobId === job.id))) fail(400, 'Os anexos do comprovativo devem pertencer a este serviço.');
    result.attachmentIds = [...ids];
  }
  return result;
}
export function jobAction(store, user, id, input) {
  requirePermission(user, input.action === 'dispatch' ? 'jobs.plan' : ['cancel', 'approveCancel', 'rejectCancel'].includes(input.action) ? 'jobs.cancel' : 'jobs.execute');
  const job = find(store, 'jobs', id); scopeJob(user, job); version(job, input);
  let details = {};
  if (input.action === 'dispatch') {
    requirePermission(user, 'jobs.plan'); state(job, ['Agendado']);
    if (job.dispatchedAt || job.cancelRequest?.status === 'Em aprovação') fail(409, 'A saída já está autorizada ou existe um cancelamento pendente.');
    if (!job.driver || !job.vehicle) fail(400, 'Atribua motorista e viatura antes de autorizar a saída.');
    if (job.driverUserId) assignment(store, { driverUserId: job.driverUserId }, job);
    blockVehicle(store, job.vehicle);
    const blockers = registryBlockers(store, job); if (blockers.length) fail(409, blockers.map(blocker => blocker.label).join(' '));
    if (store.yard.some(record => record.vehicle === job.vehicle && !record.checkedOutAt)) fail(409, 'Registe primeiro a saída da viatura do parque.');
    if (resourceConflict(store, job)) fail(409, 'Existe uma atribuição sobreposta da viatura ou motorista. Serviços sem horas ocupam dias completos.');
    job.dispatchedAt = now(); job.dispatchedBy = user.id;
  } else if (input.action === 'start') {
    requirePermission(user, 'jobs.execute'); state(job, ['Agendado']);
    if (!job.dispatchedAt) fail(409, 'Operações deve autorizar a saída antes de iniciar o serviço.');
    if (job.cancelRequest?.status === 'Em aprovação') fail(409, 'Resolva primeiro o cancelamento pendente.');
    if (job.driverUserId) assignment(store, { driverUserId: job.driverUserId }, job);
    blockVehicle(store, job.vehicle);
    const blockers = registryBlockers(store, job); if (blockers.length) fail(409, blockers.map(blocker => blocker.label).join(' '));
    if (store.yard.some(record => record.vehicle === job.vehicle && !record.checkedOutAt)) fail(409, 'Registe primeiro a saída da viatura do parque.');
    if (resourceConflict(store, job)) fail(409, 'Existe uma atribuição sobreposta da viatura ou motorista.');
    job.status = 'Em curso'; job.startedAt = now(); job.startedBy = user.id;
  } else if (input.action === 'deliver') {
    requirePermission(user, 'jobs.execute'); state(job, ['Em curso']);
    if (job.cancelRequest?.status === 'Em aprovação') fail(409, 'Resolva primeiro o cancelamento pendente.');
    job.pod = pod(input, store, job); job.status = 'Concluído'; job.completedBy = user.id; job.completedAt = now();
  } else if (input.action === 'registerPod') {
    requirePermission(user, 'jobs.execute'); state(job, ['Concluído']);
    if (job.pod) fail(409, 'O comprovativo já está registado e está bloqueado.');
    job.pod = pod(input, store, job); job.podRegisteredBy = user.id;
  } else if (input.action === 'cancel') {
    requirePermission(user, 'jobs.cancel'); state(job, ['Agendado', 'Em curso']);
    if (job.cancelRequest?.status === 'Em aprovação') fail(409, 'Já existe um cancelamento pendente.');
    job.cancelRequest = { id: randomUUID(), status: 'Em aprovação', requestedBy: user.id, requestedAt: now(), reason: text(input.reason, 'motivo do cancelamento', 1000) }; details = job.cancelRequest;
  } else if (['approveCancel', 'rejectCancel'].includes(input.action)) {
    if (user.role !== 'gerente') fail(403, 'O cancelamento exige decisão do gerente.');
    if (job.cancelRequest?.status !== 'Em aprovação') fail(409, 'Não existe um cancelamento pendente.');
    if (input.action === 'approveCancel') {
      details = approval(user, [job.cancelRequest.requestedBy], input); job.cancelRequest.approval = details;
      job.cancelRequest.status = 'Aprovado'; job.status = 'Cancelado';
    } else { job.cancelRequest.status = 'Rejeitado'; job.cancelRequest.rejectionReason = text(input.reason, 'motivo da rejeição', 1000); details = { reason: job.cancelRequest.rejectionReason }; }
    job.cancelRequest.decidedBy = user.id; job.cancelRequest.decidedAt = now();
  } else fail(400, 'Ação de serviço desconhecida.');
  updated(job); audit(store, user, `job.${input.action}`, 'job', id, details);
  const automated = ['deliver', 'registerPod'].includes(input.action) ? runAutomations(store, user, `job.${input.action}`, { job }, input) : {};
  return { job: visibleJob(store, user, job), ...(can(user, 'invoices.read') ? automated : {}) };
}

export function yardAction(store, user, input) {
  requirePermission(user, 'yard.write');
  const vehicle = text(input.vehicle, 'viatura', 40).toUpperCase();
  const job = find(store, 'jobs', input.jobId);
  if (job.status === 'Cancelado') fail(409, 'Não pode movimentar um serviço cancelado.');
  if (job.vehicle && vehicle !== job.vehicle) fail(400, 'A viatura deve corresponder ao serviço.');
  let record = store.yard.find(value => value.vehicle === vehicle && !value.checkedOutAt);
  const location = input.action === 'checkout' ? record?.location : text(input.location, 'posição no parque', 80);
  if (input.action !== 'checkout' && store.yard.some(value => !value.checkedOutAt && value.location.toLocaleLowerCase('pt-PT') === location.toLocaleLowerCase('pt-PT') && value.vehicle !== vehicle)) fail(409, 'Esta posição do parque já está ocupada.');
  if (input.action === 'checkin') {
    if (record) fail(409, 'A viatura já se encontra no parque.');
    if (store.jobs.some(value => value.vehicle === vehicle && value.status === 'Em curso')) fail(409, 'A viatura está num serviço em curso. Registe primeiro a entrega.');
    record = { ...base(user), jobId: job.id, vehicle, location, checkedInAt: now(), checkedOutAt: null, movements: [] }; store.yard.push(record);
  } else if (['move', 'checkout'].includes(input.action)) {
    if (!record) fail(409, 'A viatura não tem uma entrada ativa no parque.');
    version(record, input);
    if (record.jobId !== job.id) fail(409, 'A movimentação deve indicar o serviço associado à entrada.');
    if (input.action === 'checkout') { blockVehicle(store, vehicle); record.checkedOutAt = now(); }
    else record.location = location;
    updated(record);
  } else fail(400, 'Movimentação de parque desconhecida.');
  const movement = { action: input.action, location, at: now(), actorId: user.id, reason: text(input.reason, 'observação', 1000, false) };
  record.movements.push(movement); audit(store, user, `yard.${input.action}`, 'yard', record.id, movement);
  return { yard: record };
}
export function createWorkOrder(store, user, input) {
  requirePermission(user, 'workshop.write');
  const vehicle = text(input.vehicle, 'viatura', 40).toUpperCase();
  if (store.jobs.some(job => job.vehicle === vehicle && job.status === 'Em curso')) fail(409, 'A viatura está em serviço. Conclua o serviço antes de abrir a intervenção neste piloto.');
  const workOrder = { ...base(user), reference: ref(store, 'workOrders', 'OFI'), vehicle, description: text(input.description, 'descrição da intervenção', 2000), estimatedCostCents: money(input.estimatedCost), status: 'Rascunho' };
  store.workOrders.push(workOrder); audit(store, user, 'workshop.create', 'workOrder', workOrder.id);
  return { workOrder };
}
export function saveWorkOrder(store, user, id, input) {
  requirePermission(user, 'workshop.write');
  const order = find(store, 'workOrders', id); version(order, input); state(order, ['Rascunho', 'Rejeitada']);
  const vehicle = text(input.vehicle ?? order.vehicle, 'viatura', 40).toUpperCase();
  if (store.jobs.some(job => job.vehicle === vehicle && job.status === 'Em curso')) fail(409, 'A viatura está num serviço em curso.');
  Object.assign(order, { vehicle, description: text(input.description ?? order.description, 'descrição da intervenção', 2000), estimatedCostCents: input.estimatedCost === undefined ? order.estimatedCostCents : money(input.estimatedCost), status: 'Rascunho' });
  updated(order); audit(store, user, 'workshop.update', 'workOrder', id);
  return { workOrder: order };
}
export function workOrderAction(store, user, id, input) {
  requirePermission(user, input.action === 'release' ? 'workshop.release' : ['approve', 'reject'].includes(input.action) ? 'workshop.approve' : 'workshop.write');
  const order = find(store, 'workOrders', id); version(order, input); let details = {};
  if (input.action === 'submit') {
    requirePermission(user, 'workshop.write'); state(order, ['Rascunho', 'Rejeitada']);
    order.status = 'Em aprovação'; order.submittedBy = user.id; order.submittedAt = now();
  } else if (input.action === 'approve') {
    requirePermission(user, 'workshop.approve'); state(order, ['Em aprovação']);
    details = approval(user, [order.createdBy, order.submittedBy], input); order.approval = details; order.status = 'Aprovada'; order.approvedBy = user.id; order.approvedAt = now();
  } else if (input.action === 'reject') {
    requirePermission(user, 'workshop.approve'); state(order, ['Em aprovação']);
    order.status = 'Rejeitada'; order.rejectionReason = text(input.reason, 'motivo da rejeição', 1000); order.rejectedBy = user.id; details = { reason: order.rejectionReason };
  } else if (input.action === 'start') {
    requirePermission(user, 'workshop.write'); state(order, ['Aprovada']);
    if (store.jobs.some(job => job.vehicle === order.vehicle && job.status === 'Em curso')) fail(409, 'A viatura está num serviço em curso.');
    order.status = 'Em curso'; order.startedBy = user.id; order.startedAt = now();
  } else if (input.action === 'complete') {
    requirePermission(user, 'workshop.write'); state(order, ['Em curso']);
    order.completionNotes = text(input.reason, 'trabalho realizado e verificação', 2000);
    order.actualCostCents = money(input.actualCost); order.status = 'Concluída'; order.completedBy = user.id; order.completedAt = now(); details = { completionNotes: order.completionNotes, actualCostCents: order.actualCostCents };
  } else if (input.action === 'release') {
    requirePermission(user, 'workshop.release'); state(order, ['Concluída']);
    details = approval(user, [order.createdBy, order.completedBy], input);
    if (order.actualCostCents > order.estimatedCostCents && details.reason.length < 20) fail(400, 'O custo excede a estimativa. A libertação exige uma justificação de pelo menos 20 caracteres para aprovar o custo final.');
    details.approvedActualCostCents = order.actualCostCents; order.releaseApproval = details; order.status = 'Libertada'; order.releasedBy = user.id; order.releasedAt = now();
  } else fail(400, 'Ação de oficina desconhecida.');
  updated(order); audit(store, user, `workshop.${input.action}`, 'workOrder', id, details);
  return { workOrder: order };
}

export function createInvoice(store, user, input) {
  requirePermission(user, 'invoices.write'); const job = find(store, 'jobs', input.jobId);
  return { invoice: prepareInvoice(store, user, job, input.dueDate) };
}
function prepareInvoice(store, user, job, dueDate, automation = null) {
  if (job.status !== 'Concluído' || !job.pod) fail(409, 'Conclua o serviço e registe o comprovativo de entrega antes do registo interno de faturação.');
  if (job.priceCents <= 0) fail(409, 'O serviço não tem um preço positivo.');
  if (store.invoices.some(invoice => invoice.jobId === job.id)) fail(409, 'Já existe um registo interno de faturação para este serviço.');
  const invoice = { ...base(automation ? { id: null } : user), reference: ref(store, 'invoices', 'INT'), documentType: 'Registo interno — não é fatura fiscal', jobId: job.id, customerId: job.customerId, customer: job.customer, amountCents: job.priceCents, dueDate: date(dueDate, 'vencimento'), status: 'Rascunho', payments: [], ...(automation ? { automation, automationInitiatedBy: user.id } : {}) };
  store.invoices.push(invoice);
  if (!automation) audit(store, user, 'invoice.create', 'invoice', invoice.id);
  return invoice;
}
function assertInvoiceReady(store, invoice) {
  const job = find(store, 'jobs', invoice.jobId);
  if (job.status !== 'Concluído' || !job.pod || invoice.amountCents !== job.priceCents || invoice.customerId !== job.customerId) fail(409, 'Os dados do serviço já não correspondem à aprovação.');
}
export function saveInvoice(store, user, id, input) {
  requirePermission(user, 'invoices.write');
  const invoice = find(store, 'invoices', id); version(invoice, input); state(invoice, ['Rascunho', 'Rejeitada']);
  if ((input.amountCents != null && input.amountCents !== invoice.amountCents) || (input.amount != null && money(input.amount) !== invoice.amountCents)
    || (input.jobId != null && input.jobId !== invoice.jobId) || (input.customerId != null && input.customerId !== invoice.customerId)
    || (input.status != null && input.status !== invoice.status)) fail(409, 'Só pode alterar o prazo do rascunho. O serviço, cliente, montante e estados estão bloqueados.');
  const reason = text(input.reason, 'motivo da alteração do prazo', 1000);
  if (reason.length < 10) fail(400, 'Explique a alteração do prazo com pelo menos 10 caracteres.');
  const previousDueDate = invoice.dueDate;
  invoice.dueDate = date(input.dueDate, 'vencimento'); invoice.status = 'Rascunho'; updated(invoice);
  audit(store, user, 'invoice.updateDueDate', 'invoice', id, { previousDueDate, dueDate: invoice.dueDate, reason });
  return { invoice };
}
export function invoiceAction(store, user, id, input) {
  requirePermission(user, input.action === 'issue' ? 'invoices.issue' : input.action === 'pay' ? 'invoices.pay' : ['approve', 'reject'].includes(input.action) ? 'invoices.approve' : 'invoices.write');
  const invoice = find(store, 'invoices', id); version(invoice, input); let details = {};
  const previousInvoiceState = invoice.status, relatedJob = find(store, 'jobs', invoice.jobId), previousPaymentState = jobPayment(store, relatedJob);
  if (input.action === 'submit') {
    requirePermission(user, 'invoices.write'); state(invoice, ['Rascunho', 'Rejeitada']);
    invoice.status = 'Em aprovação'; invoice.submittedBy = user.id; invoice.submittedAt = now();
  } else if (input.action === 'approve') {
    requirePermission(user, 'invoices.approve'); state(invoice, ['Em aprovação']);
    if (!Number.isSafeInteger(input.workflowVersion) || input.workflowVersion !== store.workflowConfiguration.version) fail(409, 'Os automatismos foram alterados ou falta a sua versão. Atualize e confirme novamente a aprovação e eventual emissão interna.');
    details = approval(user, [invoice.createdBy, invoice.submittedBy, invoice.automationInitiatedBy], input); invoice.approval = details; invoice.status = 'Aprovada'; invoice.approvedBy = user.id; invoice.approvedAt = now();
  } else if (input.action === 'reject') {
    requirePermission(user, 'invoices.approve'); state(invoice, ['Em aprovação']);
    invoice.status = 'Rejeitada'; invoice.rejectionReason = text(input.reason, 'motivo da rejeição', 1000); invoice.rejectedBy = user.id; details = { reason: invoice.rejectionReason };
  } else if (input.action === 'issue') {
    requirePermission(user, 'invoices.issue'); state(invoice, ['Aprovada']);
    assertInvoiceReady(store, invoice);
    invoice.status = 'Emitida'; invoice.issuedBy = user.id; invoice.issuedAt = now();
  } else if (input.action === 'pay') {
    requirePermission(user, 'invoices.pay'); state(invoice, ['Emitida']);
    const amountCents = money(input.amount, true), reference = text(input.paymentReference, 'referência do pagamento', 180);
    if (reference.length < 3) fail(400, 'Registe uma referência de pagamento com pelo menos 3 caracteres.');
    if (store.invoices.some(value => value.payments.some(payment => payment.reference.toLocaleLowerCase('pt-PT') === reference.toLocaleLowerCase('pt-PT')))) fail(409, 'Esta referência de pagamento já foi registada. Use referências únicas por afetação.');
    const outstanding = invoice.amountCents - invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    if (amountCents > outstanding) fail(409, 'O pagamento excede o saldo em aberto.');
    const paymentDate = date(input.paymentDate ?? today(), 'pagamento');
    if (paymentDate > today()) fail(400, 'A data do pagamento não pode ser futura.');
    const payment = { id: randomUUID(), amountCents, reference, date: paymentDate, createdBy: user.id, createdAt: now() };
    invoice.payments.push(payment); if (amountCents === outstanding) invoice.status = 'Paga'; details = payment;
  } else fail(400, 'Ação de faturação desconhecida.');
  updated(invoice); const job = find(store, 'jobs', invoice.jobId); job.paymentStatus = jobPayment(store, job); updated(job);
  audit(store, user, `invoice.${input.action}`, 'invoice', id, details);
  if (input.action === 'approve') runAutomations(store, user, 'invoice.approve', { invoice }, input);
  if (input.action === 'pay') {
    if (previousInvoiceState !== invoice.status) automatedTransition(store, user, 'paymentRecordedToBalance', 'invoice.pay', 'invoice', invoice.id, previousInvoiceState, invoice.status, { paymentId: details.id });
    if (previousPaymentState !== job.paymentStatus) automatedTransition(store, user, 'paymentRecordedToBalance', 'invoice.pay', 'job', job.id, previousPaymentState, job.paymentStatus, { invoiceId: invoice.id, paymentId: details.id, stateField: 'paymentStatus' });
  }
  job.paymentStatus = jobPayment(store, job);
  return { invoice, job: visibleJob(store, user, job) };
}

function automationMetadata(store, user, ruleId, trigger) {
  return { ruleId, trigger, initiatorId: user.id, initiatorName: user.name, initiatorRole: user.role, configVersion: store.workflowConfiguration.version, at: now() };
}
function automatedTransition(store, user, ruleId, trigger, entityType, entityId, previousState, nextState, details = {}) {
  const collection = { quote: 'quotes', job: 'jobs', invoice: 'invoices' }[entityType];
  const reference = collection ? store[collection].find(item => item.id === entityId)?.reference : undefined;
  audit(store, null, 'workflow.transition', entityType, entityId, { ...automationMetadata(store, user, ruleId, trigger), reference, previousState, nextState, ...details });
}
function automationSkipped(store, user, ruleId, trigger, entityType, entityId, reason) {
  const collection = { quote: 'quotes', job: 'jobs', invoice: 'invoices' }[entityType];
  const reference = collection ? store[collection].find(item => item.id === entityId)?.reference : undefined;
  audit(store, null, 'workflow.skipped', entityType, entityId, { ...automationMetadata(store, user, ruleId, trigger), reference, reason });
}

// Called only by the authenticated, validated business actions inside the same store transaction.
// It grants a single narrow transition; it never grants the initiating actor a wider role.
function runAutomations(store, user, trigger, context, input) {
  const configuration = store.workflowConfiguration;
  if (trigger === 'quote.accept' && configuration.rules.quoteAcceptedToJob) {
    const quote = context.quote;
    state(quote, ['Aceite']);
    if (!quote.approvedBy || !quote.acceptanceReference) fail(409, 'O orçamento exige aprovação e aceitação documentada antes de criar o serviço.');
    if (quote.jobId || store.jobs.some(job => job.quoteId === quote.id)) { automationSkipped(store, user, 'quoteAcceptedToJob', trigger, 'quote', quote.id, 'existing_job'); return {}; }
    const metadata = automationMetadata(store, user, 'quoteAcceptedToJob', trigger);
    const planning = can(user, 'jobs.plan') ? input : {};
    const job = { ...base({ id: null }), reference: `TSS-${String(store.nextNumber++).padStart(4, '0')}`, customerId: quote.customerId, customer: quote.customer, pickup: quote.pickup, delivery: quote.delivery, pickupDate: quote.pickupDate, deliveryDate: quote.deliveryDate, priceCents: quote.priceCents, status: 'Agendado', paymentStatus: 'Pendente', ...assignment(store, planning), ...jobDetails({ ...planning, pickupDate: quote.pickupDate, deliveryDate: quote.deliveryDate }), quoteId: quote.id, sample: false, pod: null, automation: metadata };
    store.jobs.push(job); quote.status = 'Convertida'; quote.jobId = job.id; updated(quote);
    automatedTransition(store, user, 'quoteAcceptedToJob', trigger, 'quote', quote.id, 'Aceite', 'Convertida', { jobId: job.id });
    automatedTransition(store, user, 'quoteAcceptedToJob', trigger, 'job', job.id, null, 'Agendado', { quoteId: quote.id });
    return { job: visibleJob(store, user, job) };
  }
  if (['job.deliver', 'job.registerPod'].includes(trigger) && configuration.rules.deliveryToInvoiceDraft) {
    const job = context.job;
    if (store.invoices.some(invoice => invoice.jobId === job.id)) { automationSkipped(store, user, 'deliveryToInvoiceDraft', trigger, 'job', job.id, 'existing_document'); return {}; }
    if (job.priceCents <= 0) { automationSkipped(store, user, 'deliveryToInvoiceDraft', trigger, 'job', job.id, 'nonpositive_price'); return {}; }
    const metadata = automationMetadata(store, user, 'deliveryToInvoiceDraft', trigger);
    const invoice = prepareInvoice(store, user, job, invoiceDueDate(job.pod.deliveredAt, configuration.invoiceDueDays), metadata);
    automatedTransition(store, user, 'deliveryToInvoiceDraft', trigger, 'invoice', invoice.id, null, 'Rascunho', { jobId: job.id });
    return { invoice };
  }
  if (trigger === 'invoice.approve' && configuration.rules.invoiceApprovedToIssued) {
    const invoice = context.invoice;
    // Approval was already authorized, recorded and version-checked above. Never approve here.
    state(invoice, ['Aprovada']);
    if (user.role !== 'gerente' || invoice.approvedBy !== user.id || !invoice.approval) fail(403, 'A emissão automática exige a aprovação explícita do gerente.');
    assertInvoiceReady(store, invoice);
    invoice.status = 'Emitida'; invoice.issuedBy = null; invoice.issuedAt = now(); invoice.issueAutomation = automationMetadata(store, user, 'invoiceApprovedToIssued', trigger); updated(invoice);
    automatedTransition(store, user, 'invoiceApprovedToIssued', trigger, 'invoice', invoice.id, 'Aprovada', 'Emitida', { jobId: invoice.jobId, approvedBy: user.id });
  }
  return {};
}

export async function saveUser(store, actor, input, id) {
  requirePermission(actor, 'users.write');
  const existing = id ? find(store, 'users', id) : null;
  const role = input.role ?? existing?.role;
  if (!ROLES.some(value => value.id === role)) fail(400, 'Papel inválido.');
  if (actor.role === 'administrador' && (role === 'gerente' || existing?.role === 'gerente')) fail(403, 'Só um gerente pode criar ou gerir contas de gerente.');
  if (existing) version(existing, input);
  if (existing?.id === actor.id && role !== existing.role) fail(403, 'Não pode alterar o seu próprio papel.');
  const active = input.active ?? existing?.active ?? true;
  if (typeof active !== 'boolean') fail(400, 'O estado ativo deve ser verdadeiro ou falso.');
  if (existing?.role === 'gerente' && (role !== 'gerente' || !active) && !store.users.some(value => value.id !== existing.id && value.role === 'gerente' && value.active)) fail(409, 'É obrigatório manter pelo menos um gerente ativo.');
  const name = text(input.name ?? existing?.name, 'nome', 120), login = username(input.username ?? existing?.username);
  if (store.users.some(value => value.id !== id && value.username === login)) fail(409, 'Este nome de utilizador já existe.');
  const password = input.password != null && input.password !== '' ? await hashPassword(input.password) : existing?.password;
  if (!password) fail(400, 'Escolha uma palavra-passe para o novo utilizador.');
  let user;
  if (existing) { user = existing; Object.assign(user, { name, username: login, role, active, password, securityVersion: (user.securityVersion ?? 0) + 1 }); updated(user); }
  else { user = { ...base(actor), name, username: login, role, active, password, securityVersion: 1 }; store.users.push(user); }
  audit(store, actor, id ? 'user.update' : 'user.create', 'user', user.id, { name, username: login, role, active, passwordReset: !!input.password });
  return { user: publicUser(user) };
}
