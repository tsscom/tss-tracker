// Browser QA fixture only. The real company's data/jobs.json is never read.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../lib/security.mjs';
import { prepareStoreForMigration } from '../lib/storage.mjs';
import { initialWorkflowConfiguration } from '../lib/workflows.mjs';
import { createTrackerServer } from '../server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'tss-mobile-qa-'));
const at = new Date().toISOString();
const manager = { id: randomUUID(), name: 'Gerente de teste', username: 'qa.manager', role: 'gerente', active: true, securityVersion: 1, version: 1, createdAt: at, updatedAt: at, password: await hashPassword('Teste-local-apenas-2026') };
const driver = { id: randomUUID(), name: 'João Martins', username: 'qa.driver', role: 'motorista', active: true, securityVersion: 1, version: 1, createdAt: at, updatedAt: at, password: await hashPassword('Motorista-local-2026') };
const customerNames = ['Adega da Encosta · exemplo', 'Armazéns Tejo · exemplo', 'Mercado do Oeste · exemplo'];
const customers = customerNames.map(name => ({ id: randomUUID(), name, taxId: '', email: '', phone: '', contact: '', creditLimitCents: 0, version: 1, createdAt: at, updatedAt: at }));
const jobs = [
  ['Alenquer · Zona Industrial', 'Lisboa · Marvila', '2026-10-02', '14:00', '18:00', 'Agendado', 'QA-01-TS', 'Paletes de vinho', 12, 4200],
  ['Vila Franca de Xira · Armazém 2', 'Porto · Campanhã', '2026-10-02', '08:00', '11:00', 'Em curso', 'QA-02-TS', 'Material de embalagem', 8, 2600],
  ['Alenquer · Carregado', 'Coimbra · Taveiro', '2026-10-05', '09:00', '12:00', 'Agendado', 'QA-03-TS', 'Mercadoria geral', 6, 1900],
].map((row, index) => ({ id: randomUUID(), reference: `TSS-${String(index + 1).padStart(4, '0')}`, customer: customers[index].name, customerId: customers[index].id, pickup: row[0], delivery: row[1], pickupDate: row[2], deliveryDate: row[2], pickupTime: row[3], deliveryTime: row[4], status: row[5], vehicle: row[6], cargo: row[7], pallets: row[8], weightKg: row[9], instructions: index === 1 ? 'Entrada pelo portão 2. Contactar o destinatário à chegada.' : '', driver: driver.name, driverUserId: driver.id, priceCents: 25000 + index * 10000, paymentStatus: 'Pendente', pod: null, version: 1, createdAt: at, updatedAt: at, sample: true, ...(index < 2 ? { dispatchedAt: at, dispatchedBy: manager.id } : {}), ...(index === 1 ? { startedAt: at, startedBy: driver.id } : {}) }));
const store = prepareStoreForMigration({ schemaVersion: 2, nextNumber: 4, counters: { quotes: 1, workOrders: 1, invoices: 1 }, users: [manager, driver], customers, jobs, quotes: [], yard: [], workOrders: [], invoices: [], audit: [], workflowConfiguration: initialWorkflowConfiguration() });
const dataFile = join(directory, 'jobs.json');
await writeFile(dataFile, JSON.stringify(store, null, 2) + '\n');
const server = await createTrackerServer({ dataFile });
server.listen(4320, '127.0.0.1', () => console.log('QA móvel fictícia: http://127.0.0.1:4320/motorista — qa.driver / Motorista-local-2026. Nenhum ficheiro real foi lido.'));
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
