import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('toolchain smoke', () => {
  it('validates amounts as decimal-digit strings in minor units', () => {
    const BIGINT_MAX = 9223372036854775807n; // PostgreSQL bigint maximum, 2^63 - 1
    const amount = z
      .string()
      // abort: Zod 4 runs later checks even after a failed one, and BigInt('10.50') throws.
      .regex(/^[1-9]\d{0,18}$/, { abort: true })
      .refine((value) => BigInt(value) <= BIGINT_MAX);

    expect(amount.safeParse('1050').success).toBe(true);
    expect(amount.safeParse('0').success).toBe(false);
    expect(amount.safeParse('0001050').success).toBe(false);
    expect(amount.safeParse('10.50').success).toBe(false);
    expect(amount.safeParse((2n ** 63n - 1n).toString()).success).toBe(true);
    expect(amount.safeParse((2n ** 63n).toString()).success).toBe(false);
  });

  it('shows why amounts are bigint, not number', () => {
    expect(Number.MAX_SAFE_INTEGER + 2).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(9007199254740993n).not.toBe(9007199254740992n);
  });
});

/**
 * The lint rules of ADR-0006 and ADR-0010, run through ESLint's API on source text placed at a
 * path that does not exist. The rules under test need no type information, so the type-aware
 * rules are switched off for these virtual files.
 */
describe('lint rules for modules (ADR-0006, ADR-0010)', () => {
  let eslint: ESLint;

  beforeAll(() => {
    eslint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });
  });

  async function ruleIds(file: string, code: string): Promise<(string | null)[]> {
    const [result] = await eslint.lintText(code, { filePath: path.resolve(file) });
    if (result === undefined) throw new Error(`ESLint returned no result for ${file}`);
    return result.messages.map((message) => message.ruleId);
  }

  const MODULE_LAYERS = [
    'src/modules/accounts/domain/probe.ts',
    'src/modules/movements/application/probe.ts',
    'src/modules/ledger/application/nested/probe.ts',
  ];

  it.each([
    ['Number()', 'export const value = Number("10");'],
    ['new Number()', 'export const value = new Number("10");'],
    ['Number as a function value', 'export const values = ["1"].map(Number);'],
    ['Number.parseInt', 'export const value = Number.parseInt("10", 10);'],
    ['Number.parseFloat', 'export const value = Number.parseFloat("10.5");'],
    ['parseInt', 'export const value = parseInt("10", 10);'],
    ['parseFloat', 'export const value = parseFloat("10.5");'],
    ['unary +', 'const text = "10";\nexport const value = +text;'],
    [
      'Number assigned to another name',
      "const toNumber = Number;\nexport const value = toNumber('1');",
    ],
  ])('fails on %s in domain and application code', async (_, code) => {
    for (const file of MODULE_LAYERS) {
      const ids = await ruleIds(file, code);
      expect(ids.length, `${file}: ${code}`).toBeGreaterThan(0);
      expect(
        ids.every((id) =>
          ['no-restricted-syntax', 'no-restricted-globals', 'no-restricted-properties'].includes(
            id ?? '',
          ),
        ),
      ).toBe(true);
    }
  });

  it('accepts bigint arithmetic in domain and application code, and Number() outside them', async () => {
    const money = 'const a = BigInt("10");\nexport const b = a + 1n;\nexport const c = -a;';
    for (const file of MODULE_LAYERS) expect(await ruleIds(file, money)).toEqual([]);
    expect(
      await ruleIds('src/modules/accounts/adapters/http/probe.ts', 'export const v = Number("1");'),
    ).toEqual([]);
  });

  it.each([
    'kysely',
    'kysely/helpers/postgres',
    'pg',
    'fastify',
    '@fastify/helmet',
    'ioredis',
    '../adapters/persistence/kysely-accounts.js',
    '../../adapters/http/routes.js',
    '../../../platform/db/unit-of-work.js',
    '../../../platform/db/schema.js',
    '../../../platform/db/sqlstate.js',
    '../../../platform/db/errors.js.map',
    '../../../platform/audit/kysely-audit-log.js',
  ])('fails on an import of %s from application code', async (specifier) => {
    const ids = await ruleIds(
      'src/modules/accounts/application/probe.ts',
      `import '${specifier}';`,
    );
    expect(ids).toEqual(['no-restricted-imports']);
  });

  it.each([
    ['src/modules/accounts/application/probe.ts', '../../ledger/domain/currency.js'],
    ['src/modules/accounts/application/probe.ts', '../../ledger/application/ports.js'],
    ['src/modules/accounts/application/probe.ts', '../../../modules/ledger/domain/currency.js'],
    ['src/modules/accounts/domain/probe.ts', '../../../modules/ledger/domain/currency.js'],
    ['src/modules/movements/application/nested/probe.ts', '../../../accounts/domain/account.js'],
    ['src/modules/accounts/domain/probe.ts', '../../ledger/domain/currency.js'],
    ['src/modules/accounts/adapters/persistence/probe.ts', '../../../ledger/adapters/x.js'],
  ])('fails when %s imports %s, another module internals', async (file, specifier) => {
    expect(await ruleIds(file, `import '${specifier}';`)).toEqual(['no-restricted-imports']);
  });

  it('accepts imports of the own module and of another module index.ts from application code', async () => {
    const code = [
      "import '../domain/account.js';",
      "import './ports.js';",
      "import '../../ledger/index.js';",
      "import '../../accounts/domain/account.js';",
      "import '../../../modules/accounts/domain/account.js';",
      "import '../../../modules/ledger/index.js';",
      "import 'node:crypto';",
      // The typed errors of the platform, which import nothing (plan 005 section 3).
      "import '../../../platform/db/errors.js';",
    ].join('\n');
    expect(await ruleIds('src/modules/accounts/application/probe.ts', code)).toEqual([]);
    expect(
      await ruleIds(
        'src/modules/accounts/adapters/persistence/probe.ts',
        "import 'kysely';\nimport '../../application/ports.js';\nimport '../../../../platform/db/schema.js';",
      ),
    ).toEqual([]);
  });
});

const STATEMENT_TIMEOUT_CALL = 'app.set_statement_timeout';
const STATEMENT_TIMEOUT_CALLERS = [
  'src/modules/ledger/adapters/cli/reconcile.ts',
  'src/modules/idempotency/adapters/cli/cleanup.ts',
];

/** Every file under `root` whose text contains `needle`, as paths relative to `base`. */
async function filesContaining(root: string, needle: string, base: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    if ((await readFile(file, 'utf8')).includes(needle)) {
      found.push(path.relative(base, file).split(path.sep).join('/'));
    }
  }
  return found.sort();
}

describe('statement timeout calls (SEC-R48, ADR-0021)', () => {
  it('SEC-R48 app.set_statement_timeout appears in no file of src/ but the reconcile and cleanup scripts', async () => {
    const offenders = (await filesContaining('src', STATEMENT_TIMEOUT_CALL, '.')).filter(
      (file) => !STATEMENT_TIMEOUT_CALLERS.includes(file),
    );
    expect(offenders).toEqual([]);
  });

  it('SEC-R48 the text check finds the call in any file, nested or not', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'scf-toolchain-'));
    try {
      await mkdir(path.join(root, 'src/modules/accounts/adapters'), { recursive: true });
      await writeFile(path.join(root, 'src/main.ts'), 'export {};\n');
      await writeFile(
        path.join(root, 'src/modules/accounts/adapters/sneaky.ts'),
        'await sql`SELECT app.set_statement_timeout(600000)`;\n',
      );
      expect(await filesContaining(path.join(root, 'src'), STATEMENT_TIMEOUT_CALL, root)).toEqual([
        'src/modules/accounts/adapters/sneaky.ts',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
