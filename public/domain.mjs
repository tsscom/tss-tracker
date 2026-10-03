export const JOB_STATUSES = ['Agendado', 'Em curso', 'Concluído', 'Cancelado'];
export const PAYMENT_STATUSES = ['Pendente', 'Pago', 'Em atraso'];

export function parsePrice(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,8}(?:[.,]\d{1,2})?$/.test(text)) throw new Error('Introduza um preço válido, como 850,00.');
  const [whole, fraction = ''] = text.replace(',', '.').split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

export function normalizeJob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dados do serviço inválidos.');
  const job = {};
  for (const [key, label, max, required] of [
    ['customer', 'cliente', 120, true], ['pickup', 'local de recolha', 180, true],
    ['delivery', 'local de entrega', 180, true], ['driver', 'motorista', 100, false],
    ['vehicle', 'viatura', 40, false],
  ]) {
    if (input[key] != null && typeof input[key] !== 'string') throw new Error(`O campo ${label} é inválido.`);
    job[key] = (input[key] ?? '').trim();
    if (required && !job[key]) throw new Error(`Preencha o campo ${label}.`);
    if (job[key].length > max) throw new Error(`O campo ${label} pode ter até ${max} caracteres.`);
  }
  if (!validDate(input.pickupDate) || !validDate(input.deliveryDate)) throw new Error('Introduza datas válidas de recolha e entrega.');
  if (input.deliveryDate < input.pickupDate) throw new Error('A entrega não pode ser anterior à recolha.');
  if (!JOB_STATUSES.includes(input.status)) throw new Error('Estado do serviço inválido.');
  if (!PAYMENT_STATUSES.includes(input.paymentStatus)) throw new Error('Estado do pagamento inválido.');
  job.pickupDate = input.pickupDate;
  job.deliveryDate = input.deliveryDate;
  job.priceCents = parsePrice(input.quotedPrice);
  job.status = input.status;
  job.paymentStatus = input.paymentStatus;
  return job;
}

const fold = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function filterJobs(jobs, filters = {}) {
  const terms = fold(filters.search).trim().split(/\s+/).filter(Boolean);
  return jobs.filter(job => {
    const haystack = fold([job.reference, job.customer, job.pickup, job.delivery, job.driver, job.vehicle].join(' '));
    return terms.every(term => haystack.includes(term))
      && (!filters.status || job.status === filters.status)
      && (!filters.paymentStatus || job.paymentStatus === filters.paymentStatus)
      && (!filters.customer || job.customer === filters.customer)
      && (!filters.from || job.pickupDate >= filters.from)
      && (!filters.to || job.pickupDate <= filters.to);
  }).sort((a, b) => a.pickupDate.localeCompare(b.pickupDate) || a.reference.localeCompare(b.reference));
}

export function toCsv(jobs) {
  function cell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  }
  const rows = [
    ['Referência', 'Cliente', 'Local de recolha', 'Local de entrega', 'Data de recolha', 'Data de entrega',
      'Motorista', 'Viatura', 'Preço acordado (EUR)', 'Estado do serviço', 'Estado do pagamento'],
    ...jobs.map(job => [job.reference, job.customer, job.pickup, job.delivery, job.pickupDate, job.deliveryDate,
      job.driver, job.vehicle, (job.priceCents / 100).toFixed(2).replace('.', ','), job.status, job.paymentStatus]),
  ];
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n') + '\r\n';
}
