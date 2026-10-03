import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createTrackerServer } from '../server.mjs';
import { normalizeJob, parsePrice, filterJobs, toCsv } from '../public/domain.mjs';

const input = {
  customer: 'João & Filhos', pickup: 'Alenquer', delivery: 'Évora', pickupDate: '2026-09-30',
  deliveryDate: '2026-10-01', driver: 'Ana Ferreira', vehicle: 'AB-12-CD', quotedPrice: '1234,56',
  status: 'Agendado', paymentStatus: 'Pendente',
};

test('Portuguese prices, required fields and calendar dates', () => {
  assert.equal(parsePrice('1234,56'), 123456);
  assert.equal(parsePrice('1234.56'), 123456);
  assert.equal(parsePrice('0'), 0);
  assert.equal(parsePrice('8,5'), 850);
  for (const price of ['-1', 'NaN', '1e3', '12,345', '', '123,4,5']) assert.throws(() => parsePrice(price));
  assert.equal(normalizeJob(input).priceCents, 123456);
  for (const change of [{ customer: ' ' }, { pickupDate: '2026-02-29' }, { deliveryDate: '2026-09-29' }, { status: 'Inválido' }, { paymentStatus: 'Parcial' }]) assert.throws(() => normalizeJob({ ...input, ...change }));
});

test('Search ignores accents and combines all filters', () => {
  const job = { ...normalizeJob(input), id: 'one', reference: 'TSS-0010' };
  assert.equal(filterJobs([job], { search: 'joao evora' }).length, 1);
  assert.equal(filterJobs([job], { search: 'AB-12', customer: 'João & Filhos', status: 'Agendado', paymentStatus: 'Pendente', from: '2026-09-30', to: '2026-09-30' }).length, 1);
  assert.equal(filterJobs([job], { status: 'Concluído' }).length, 0);
  assert.equal(filterJobs([job], { from: '2026-10-01' }).length, 0);
});

test('CSV keeps accents, cents, delimiters and quoted values, and neutralises formulas', () => {
  const job = { ...normalizeJob(input), reference: 'TSS-0010', customer: '=HYPERLINK("bad")', pickup: 'Armazém; "A"\nLisboa' };
  const csv = toCsv([job]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"1234,56"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('"Armazém; ""A""\nLisboa"'));
  assert.ok(csv.includes('"Évora"'));
  assert.ok(csv.endsWith('\r\n'));
});

test('Malformed data files fail visibly without being overwritten', async t => {
  const work = await mkdtemp(join(tmpdir(), 'tss-tracker-test-'));
  const dataFile = join(work, 'jobs.json');
  await writeFile(dataFile, '{broken', 'utf8');
  t.after(async () => { await unlink(dataFile); await rmdir(work); });
  await assert.rejects(() => createTrackerServer({ dataFile }), /preservado/);
  assert.equal(await readFile(dataFile, 'utf8'), '{broken');
});
