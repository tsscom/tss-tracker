import { randomUUID } from 'node:crypto';
import { initialWorkflowConfiguration } from '../../lib/workflows.mjs';
import { saveCustomer, createQuote, quoteAction, jobAction, invoiceAction, yardAction, createWorkOrder } from '../../lib/business.mjs';

const OVERRIDE = { ownerOverride: true, reason: 'Aprovação pelo proprietário no cenário fictício de integração.' };

export function importFixture() {
  const at = '2026-09-30T12:34:56.000Z';
  const owner = {
    id: randomUUID(), name: 'Gerente de teste', username: 'postgres.test', role: 'gerente', active: true,
    password: { algorithm: 'scrypt', salt: 'ab'.repeat(16), hash: 'cd'.repeat(64), N: 131072, r: 8, p: 1 },
    securityVersion: 3, version: 2, createdAt: at, updatedAt: at,
  };
  const store = {
    schemaVersion: 2, nextNumber: 1, counters: { quotes: 1, workOrders: 1, invoices: 1 },
    users: [owner], customers: [], jobs: [], quotes: [], yard: [], workOrders: [], invoices: [], audit: [],
    workflowConfiguration: initialWorkflowConfiguration(),
    migration: { from: 1, at, backupFile: 'fixture-only-backup.json', note: 'Metadados fictícios preservados.' },
    extensionMetadata: { owner: 'TSS teste', tags: ['Portugal', 'euros'], revision: 7 },
  };
  const { customer } = saveCustomer(store, owner, { name: 'Cliente fictício Évora', taxId: 'PT123456789', email: 'teste@example.test' });
  const { quote } = createQuote(store, owner, { customerId: customer.id, pickup: 'Alenquer', delivery: 'Évora', pickupDate: '2026-10-10', deliveryDate: '2026-10-11', quotedPrice: '100,00' });
  quoteAction(store, owner, quote.id, { action: 'submit', version: quote.version });
  quoteAction(store, owner, quote.id, { action: 'approve', version: quote.version, ...OVERRIDE });
  const { job } = quoteAction(store, owner, quote.id, { action: 'accept', version: quote.version, acceptanceReference: 'Email de teste', driver: 'Motorista fictício', vehicle: 'IMPORT-01' });
  const storedJob = store.jobs.find(value => value.id === job.id);
  jobAction(store, owner, job.id, { action: 'dispatch', version: storedJob.version });
  jobAction(store, owner, job.id, { action: 'start', version: storedJob.version });
  jobAction(store, owner, job.id, { action: 'deliver', version: storedJob.version, pod: { recipient: 'Destinatário de teste', reference: 'POD-IMPORT-01' } });
  const invoice = store.invoices[0];
  invoiceAction(store, owner, invoice.id, { action: 'submit', version: invoice.version });
  invoiceAction(store, owner, invoice.id, { action: 'approve', version: invoice.version, workflowVersion: 1, ...OVERRIDE });
  invoiceAction(store, owner, invoice.id, { action: 'pay', version: invoice.version, amount: '75,00', paymentReference: 'PAY-IMPORT-01' });
  invoiceAction(store, owner, invoice.id, { action: 'pay', version: invoice.version, amount: '20,00', paymentReference: 'PAY-IMPORT-02' });
  yardAction(store, owner, { action: 'checkin', jobId: job.id, vehicle: 'IMPORT-01', location: 'Posição Évora 1' });
  createWorkOrder(store, owner, { vehicle: 'IMPORT-WORK', description: 'Inspeção fictícia para testar a importação.', estimatedCost: '50,00' });
  const other = saveCustomer(store, owner, { name: 'Segundo cliente fictício' }).customer;
  createQuote(store, owner, { customerId: other.id, pickup: 'Alenquer', delivery: 'Lisboa', pickupDate: '2026-10-12', deliveryDate: '2026-10-12', quotedPrice: '50,00' });
  // Imported order is intentionally different from natural ID/reference order.
  store.customers.sort((first, second) => second.id.localeCompare(first.id));
  store.quotes.reverse();
  storedJob.extension = { dispatchNote: 'Preservar campos adicionais do serviço.' };
  // JSON compatibility is also the import contract: no undefined values or dates
  // represented as JS objects are silently added to the expected snapshot.
  return JSON.parse(JSON.stringify(store));
}
