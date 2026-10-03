import { fail, requirePermission, text } from './security.mjs';

export const WORKFLOW_CATALOG = [
  { id: 'quoteAcceptedToJob', title: 'Aceitação → serviço agendado', trigger: 'quote.accept', transition: 'Aceite → Convertida · novo serviço Agendado', description: 'Depois da aprovação do gerente e da aceitação documentada pelo cliente, cria um único serviço. A atribuição e a saída continuam sujeitas aos controlos de operações.' },
  { id: 'deliveryToInvoiceDraft', title: 'Comprovativo de entrega → rascunho interno', trigger: 'job.deliver / job.registerPod', transition: 'Concluído com POD → novo registo interno Rascunho', description: 'Prepara um único registo interno de faturação pelo preço aprovado. O financeiro deve conferir e submeter; não cria uma fatura fiscal nem um pagamento.' },
  { id: 'invoiceApprovedToIssued', title: 'Aprovação do gerente → emissão interna', trigger: 'invoice.approve', transition: 'Aprovada → Emitida', description: 'Emite o registo interno apenas após uma aprovação explícita e válida do gerente e a verificação do serviço, do POD e do montante.' },
];
export const WORKFLOW_RULE_IDS = WORKFLOW_CATALOG.map(rule => rule.id);
export function initialWorkflowConfiguration() {
  return { version: 1, rules: Object.fromEntries(WORKFLOW_RULE_IDS.map(id => [id, true])), invoiceDueDays: 30, updatedAt: null, updatedBy: null };
}
export function validateWorkflowConfiguration(configuration) {
  if (!configuration || !Number.isSafeInteger(configuration.version) || configuration.version < 1
    || !configuration.rules || Object.keys(configuration.rules).length !== WORKFLOW_RULE_IDS.length
    || WORKFLOW_RULE_IDS.some(id => typeof configuration.rules[id] !== 'boolean')
    || !Number.isSafeInteger(configuration.invoiceDueDays) || configuration.invoiceDueDays < 1 || configuration.invoiceDueDays > 365) {
    throw new Error('Configuração de automatismos inválida. Os dados foram preservados.');
  }
}
export function workflowView(store, user) {
  requirePermission(user, 'workflows.read');
  return { configuration: structuredClone(store.workflowConfiguration), catalog: WORKFLOW_CATALOG, editable: user.role === 'gerente' };
}
export function updateWorkflowConfiguration(store, user, input, writeAudit) {
  requirePermission(user, 'workflows.write');
  const previous = store.workflowConfiguration;
  if (!Number.isSafeInteger(input.version) || input.version !== previous.version) fail(409, 'A configuração foi alterada ou falta a versão atual. Atualize antes de guardar.');
  if (!input.rules || typeof input.rules !== 'object' || Array.isArray(input.rules)
    || Object.keys(input.rules).length !== WORKFLOW_RULE_IDS.length || WORKFLOW_RULE_IDS.some(id => typeof input.rules[id] !== 'boolean')) fail(400, 'Indique verdadeiro ou falso para cada uma das três regras de automatização.');
  if (!Number.isSafeInteger(input.invoiceDueDays) || input.invoiceDueDays < 1 || input.invoiceDueDays > 365) fail(400, 'O prazo de pagamento deve ser um número inteiro de 1 a 365 dias.');
  const reason = text(input.reason, 'motivo da alteração dos automatismos', 1000);
  if (reason.length < 10) fail(400, 'Explique a alteração dos automatismos com pelo menos 10 caracteres.');
  const next = { version: previous.version + 1, rules: Object.fromEntries(WORKFLOW_RULE_IDS.map(id => [id, input.rules[id]])), invoiceDueDays: input.invoiceDueDays, updatedAt: new Date().toISOString(), updatedBy: user.id };
  store.workflowConfiguration = next;
  writeAudit(store, user, 'workflow.settings.update', 'workflowConfiguration', 'business', { previous, next, reason, futureTriggersOnly: true });
  return workflowView(store, user);
}

// Calendar arithmetic is independent of DST. The POD instant first becomes a Lisbon date.
export function invoiceDueDate(deliveredAt, days) {
  const instant = new Date(deliveredAt);
  if (Number.isNaN(instant.getTime())) fail(400, 'A data do comprovativo de entrega é inválida.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(part => [part.type, part.value]));
  const calendar = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  calendar.setUTCDate(calendar.getUTCDate() + days);
  return calendar.toISOString().slice(0, 10);
}
