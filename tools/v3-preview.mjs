// Fictional review workspace: never opens the company's data or credentials.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrackerServer } from '../server.mjs';
const dir = await mkdtemp(join(tmpdir(), 'tss-v3-preview-'));
const server = await createTrackerServer({ dataFile: join(dir, 'jobs.json') });
await new Promise(done => server.listen(4318, '127.0.0.1', done));
const base = 'http://127.0.0.1:4318';
const password = 'Teste-local-apenas-2026';
let cookie = '', csrf = '';
async function call(path, input, method = 'POST') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-TSS-Request': '1', Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(input) });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  const body = await response.json(); if (body.csrfToken) csrf = body.csrfToken;
  if (!response.ok) throw new Error(`${path}: ${body.error}`); return body;
}
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
await call('/api/setup', { name: 'Gerente de teste', username: 'qa.manager', password });
const driverUser = (await call('/api/users', { name: 'Ana — exemplo', username: 'qa.driver', password, role: 'motorista', active: true })).user;
const driver = (await call('/api/drivers', { name: driverUser.name, userId: driverUser.id, phone: '+351 000 000 000', licenseExpiryDate: '2035-12-31' })).driver;
const vehicle = (await call('/api/vehicles', { registration: 'TEST-03', make: 'Volvo', model: 'FH — exemplo', capacityKg: 24000, capacityPallets: 33, odometerKm: 420000, nextServiceKm: 419000, inspectionDueDate: '2035-12-31', insuranceDueDate: '2035-12-31' })).vehicle;
const customer = (await call('/api/customers', { name: 'Cliente fictício — distribuição', email: 'exemplo@example.test', phone: '+351 000 000 001' })).customer;
let quote = (await call('/api/quotes', { customerId: customer.id, pickup: 'Armazém de Alenquer — exemplo', delivery: 'Plataforma de Lisboa — exemplo', pickupDate: today, deliveryDate: today, quotedPrice: '650,00' })).quote;
quote = (await call(`/api/quotes/${quote.id}/actions`, { action: 'submit', version: quote.version })).quote;
quote = (await call(`/api/quotes/${quote.id}/actions`, { action: 'approve', version: quote.version, ownerOverride: true, reason: 'Validação de dados exclusivamente fictícios na pré-visualização.' })).quote;
let job = (await call(`/api/quotes/${quote.id}/actions`, { action: 'accept', version: quote.version, acceptanceReference: 'Encomenda fictícia QA' })).job;
job = (await call(`/api/jobs/${job.id}`, { version: job.version, driverId: driver.id, vehicleId: vehicle.id, pickupTime: '08:30', deliveryTime: '11:00', cargo: 'Produtos embalados — exemplo', weightKg: 6500, pallets: 12, instructions: 'Apresentar a referência na portaria. Dados fictícios de revisão.' }, 'PUT')).job;
job = (await call(`/api/jobs/${job.id}/actions`, { action: 'dispatch', version: job.version })).job;
let opportunity = (await call('/api/opportunities', { customerId: customer.id, title: 'Distribuição semanal — exemplo', expectedValue: '5200', nextFollowUpDate: today })).opportunity;
opportunity = (await call(`/api/opportunities/${opportunity.id}/actions`, { action: 'stage', version: opportunity.version, status: 'Negociação', reason: 'Revisão de proposta fictícia' })).opportunity;
await call('/api/activities', { opportunityId: opportunity.id, type: 'Chamada', description: 'Confirmar janela de entrega e frequência semanal.', dueDate: today });
await call('/api/costs', { jobId: job.id, category: 'Combustível', amount: '125', date: today, supplier: 'Posto fictício', reference: 'QA-CUSTO-01' });
await call('/api/costs', { jobId: job.id, category: 'Portagens', amount: '15,75', date: today, supplier: 'Operador fictício', reference: 'QA-CUSTO-02' });
await call('/api/incidents', { jobId: job.id, type: 'delay', severity: 'medium', description: 'Janela de descarga a confirmar — exemplo fictício.' });
console.log('Pré-visualização fictícia pronta: ' + base);
console.log('Desktop: qa.manager / ' + password + ' — Motorista: qa.driver / ' + password);
const stop = () => server.close(async () => { await server.storage.close(); process.exit(0); });
process.on('SIGINT', stop); process.on('SIGTERM', stop);
