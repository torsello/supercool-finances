import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_SUFFIXES = ['_SECRET', '_PASSWORD', '_KEY', '_TOKEN'];

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export interface EnvSyncResult {
  created: boolean;
  added: string[];
}

function parseEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    const key = match?.[1];
    if (key !== undefined && !line.trimStart().startsWith('#')) {
      entries.set(key, match?.[2] ?? '');
    }
  }
  return entries;
}

export function generateSecret(): string {
  return randomBytes(48).toString('base64');
}

/**
 * Creates the env file if missing and appends every key of the example file that it lacks.
 * Keys ending in _SECRET, _PASSWORD, _KEY or _TOKEN get a random value instead of the example
 * placeholder. Existing keys are never changed, and the file is left readable by its owner only. Returns key names only, never values.
 */
export function syncEnv(
  examplePath: string,
  envPath: string,
  secret: () => string = generateSecret,
): EnvSyncResult {
  const example = parseEntries(readFileSync(examplePath, 'utf8'));
  const created = !existsSync(envPath);
  const current = created ? '' : readFileSync(envPath, 'utf8');
  const existing = parseEntries(current);

  const added: string[] = [];
  const lines: string[] = [];
  for (const [key, value] of example) {
    if (existing.has(key)) continue;
    const generated = GENERATED_SUFFIXES.some((suffix) => key.endsWith(suffix));
    lines.push(`${key}=${generated ? secret() : value}`);
    added.push(key);
  }

  if (created) {
    writeFileSync(envPath, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  } else if (lines.length > 0) {
    const separator = current.length > 0 && !current.endsWith('\n') ? '\n' : '';
    appendFileSync(envPath, `${separator}${lines.join('\n')}\n`);
    chmodSync(envPath, 0o600);
  }

  return { created, added };
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  const { created, added } = syncEnv('.env.example', '.env');
  if (created) console.log('Created .env');
  console.log(added.length > 0 ? `Added keys: ${added.join(', ')}` : '.env is up to date');
}
