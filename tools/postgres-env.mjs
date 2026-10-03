import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const envError = message => Object.assign(new Error(message), { code: 'TSS_ENV_INVALID', safeForConsole: true });

/** Load the project's optional .env without replacing variables supplied by the shell. */
export async function loadLocalEnv(file = fileURLToPath(new URL('../.env', import.meta.url)), environment = process.env) {
  let content;
  try { content = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw envError('Não foi possível ler o ficheiro .env.'); }
  const entries = new Map();
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw envError(`Formato .env inválido na linha ${index + 1}.`);
    if (['__proto__', 'constructor', 'prototype'].includes(match[1])) throw envError(`Nome de variável .env inválido na linha ${index + 1}.`);
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closing = value.indexOf(quote, 1);
      if (closing < 0 || !/^\s*(?:#.*)?$/.test(value.slice(closing + 1))) throw envError(`Valor .env inválido na linha ${index + 1}.`);
      value = value.slice(1, closing);
    } else value = value.split('#', 1)[0].trim();
    if (value.includes('\0')) throw envError(`Valor .env inválido na linha ${index + 1}.`);
    if (entries.has(match[1])) throw envError(`Variável .env repetida na linha ${index + 1}.`);
    entries.set(match[1], value);
  }
  // Parse everything before applying anything, so an invalid file cannot be partly loaded.
  for (const [key, value] of entries) if (environment[key] === undefined) environment[key] = value;
  return true;
}
