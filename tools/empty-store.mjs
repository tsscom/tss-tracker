import { initialWorkflowConfiguration } from '../lib/workflows.mjs';
import { OPERATIONAL_COLLECTIONS } from '../lib/operations.mjs';
import { validateStore } from '../lib/storage.mjs';

export function emptyStore() {
  const store = {
    schemaVersion: 2,
    nextNumber: 1,
    counters: { quotes: 1, workOrders: 1, invoices: 1 },
    workflowConfiguration: initialWorkflowConfiguration(),
    ...Object.fromEntries([
      'users', 'customers', 'jobs', 'quotes', 'yard', 'workOrders', 'invoices', 'audit',
      ...OPERATIONAL_COLLECTIONS,
    ].map(key => [key, []])),
  };
  validateStore(store);
  return store;
}
