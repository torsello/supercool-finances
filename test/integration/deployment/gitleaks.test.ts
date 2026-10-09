import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DEMO_SECRETS } from '../../../src/platform/config/config.js';
import { readRepositoryFile, REPOSITORY_ROOT } from '../../support/deployment.js';

/**
 * gitleaks at the version the CI job `secret-scan` installs: the binary of the tools image, or its
 * official image pinned by digest (plan 008 section 7). The test fails when the CI version moves
 * and this pin, or the Dockerfile's, does not.
 */
const GITLEAKS_VERSION = '8.30.1';
const GITLEAKS_IMAGE = `ghcr.io/gitleaks/gitleaks:v${GITLEAKS_VERSION}@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f`;

interface Finding {
  RuleID: string;
  StartLine: number;
  File: string;
}

interface Scan {
  code: number | null;
  findings: Finding[];
  /** What gitleaks logged, on stderr. */
  log: string;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command; `undefined` when it is not installed. */
function run(command: string, args: readonly string[]): Promise<Run | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') resolve(undefined);
      else reject(error);
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function docker(args: readonly string[]): Promise<Run> {
  const result = await run('docker', args);
  if (result === undefined) throw new Error('neither gitleaks nor docker is on the PATH');
  return result;
}

/** The arguments of `gitleaks dir` on `compose.yaml` in `dir`, the report on stdout. */
function scanArgs(dir: string, withConfig: boolean): string[] {
  return [
    'dir',
    `${dir}/compose.yaml`,
    ...(withConfig ? ['--config', `${dir}/.gitleaks.toml`] : []),
    '--no-banner',
    '--redact',
    '--report-format',
    'json',
    '--report-path',
    '-',
  ];
}

function scanOf(result: Run): Scan {
  // Proof that the file was read: gitleaks reports the bytes it scanned.
  expect(result.stderr).toMatch(/scanned ~[1-9][0-9]* bytes/);
  return {
    code: result.code,
    findings: JSON.parse(result.stdout) as Finding[],
    log: result.stderr,
  };
}

/**
 * The gitleaks binary on the PATH, as the tools image installs it, when there is one: it must be
 * the version of the CI job secret-scan. Otherwise the official image is used.
 */
async function gitleaksOnPath(): Promise<boolean> {
  const version = await run('gitleaks', ['version']);
  if (version === undefined) return false;
  expect(version.code, version.stderr).toBe(0);
  expect(version.stdout.trim().replace(/^v/, '')).toBe(GITLEAKS_VERSION);
  return true;
}

/**
 * Runs `gitleaks dir` on `dir/compose.yaml` with the repository's configuration, if any: with the
 * binary on the PATH, or else in the official image. There the files are copied into the container
 * rather than mounted, since Docker may not share the temporary folder with its VM (colima shares
 * only the home directory).
 */
async function scan(dir: string): Promise<Scan> {
  const config = join(REPOSITORY_ROOT, '.gitleaks.toml');
  const withConfig = existsSync(config);
  if (withConfig) copyFileSync(config, join(dir, '.gitleaks.toml'));
  if (await gitleaksOnPath()) {
    const result = await run('gitleaks', scanArgs(dir, withConfig));
    if (result === undefined) throw new Error('gitleaks disappeared from the PATH');
    return scanOf(result);
  }
  const created = await docker([
    'create',
    '--network',
    'none',
    GITLEAKS_IMAGE,
    ...scanArgs('/scan', withConfig),
  ]);
  expect(created.code, created.stderr).toBe(0);
  const container = created.stdout.trim();
  try {
    const copied = await docker(['cp', `${dir}/.`, `${container}:/scan`]);
    expect(copied.code, copied.stderr).toBe(0);
    return scanOf(await docker(['start', '--attach', container]));
  } finally {
    await docker(['rm', '--force', container]);
  }
}

/** The example Idempotency-Key of the OpenAPI document, a documented non-secret (DEP-R36). */
const OPENAPI_EXAMPLE_KEY = '5b0d7f1e-6c2a-4e8b-9f3d-2a1c4e6b8d0f';

/** The values DEP-R36 allows the gitleaks allowlist to name. */
const ALLOWED_VALUES: readonly string[] = [...Object.values(DEMO_SECRETS), OPENAPI_EXAMPLE_KEY];

/**
 * The lines `.gitleaks.toml` may hold (DEP-R36): an allowlist of lines, not a denylist, so a
 * stopword, a legacy `[allowlist]` table, a path or any other key is refused.
 */
const ACCEPTED_LINES: readonly RegExp[] = [
  /^$/,
  /^#.*$/,
  /^\[extend\]$/,
  /^useDefault = true$/,
  /^\[\[allowlists\]\]$/,
  /^description = "[^"\\]*"$/,
  /^regexTarget = "secret"$/,
  /^regexes = \['''[^']*'''\]$/,
];

/** `value` with every character that has a meaning in a regular expression escaped. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Why a `.gitleaks.toml` breaks DEP-R36, one message per offending line or regex: every line must
 * be one of `ACCEPTED_LINES`, and each regex exactly `^`, one value of `ALLOWED_VALUES` escaped,
 * and `$`.
 */
function allowlistProblems(config: string): string[] {
  const problems: string[] = [];
  for (const [index, raw] of config.split('\n').entries()) {
    const line = raw.trim();
    if (!ACCEPTED_LINES.some((accepted) => accepted.test(line))) {
      problems.push(`line ${String(index + 1)} is not accepted: ${line}`);
      continue;
    }
    const regex = /^regexes = \['''([^']*)'''\]$/.exec(line)?.[1];
    if (regex === undefined) continue;
    // Exactly one allowed value, escaped and anchored: no alternation, class or wildcard can widen
    // it to other values (DEP-R36).
    const exact = ALLOWED_VALUES.filter((value) => regex === `^${escapeRegExp(value)}$`);
    if (exact.length !== 1) {
      problems.push(`regex ${regex} is not exactly ^ + one escaped allowed value + $`);
    }
  }
  return problems;
}

/** A value in the format of an AWS access key id, generated here and never committed. */
function fakeAccessKeyId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let suffix = '';
  for (let index = 0; index < 16; index += 1) suffix += alphabet.charAt(randomInt(alphabet.length));
  return `AKIA${suffix}`;
}

/** A folder of its own holding `compose.yaml` with the given content. */
function folderWith(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scf-gitleaks-'));
  writeFileSync(join(dir, 'compose.yaml'), content);
  return dir;
}

describe('gitleaks and the demo secrets', () => {
  it('DEP-AC25 gitleaks finds nothing in compose.yaml, finds an AWS key put in place of JWT_SECRET, and the allowlist holds only the anchored values DEP-R36 names', async () => {
    // The version of the CI job secret-scan.
    const workflow = parse(readRepositoryFile('.github/workflows/ci.yml')) as {
      jobs: { 'secret-scan': { env: { GITLEAKS_VERSION: string } } };
    };
    expect(workflow.jobs['secret-scan'].env.GITLEAKS_VERSION).toBe(GITLEAKS_VERSION);
    expect(readRepositoryFile('Dockerfile')).toContain(
      `ARG GITLEAKS_VERSION=${GITLEAKS_VERSION}\n`,
    );

    const compose = readRepositoryFile('compose.yaml');
    for (const value of Object.values(DEMO_SECRETS)) {
      expect(compose).toContain(value);
      expect(Buffer.byteLength(value)).toBe(48);
    }
    expect(DEMO_SECRETS).toEqual({
      JWT_SECRET: 'demo-only-jwt-secret-for-docker-compose-00000000',
      CURSOR_SECRET: 'demo-only-cursor-secret-for-docker-compose-00000',
    });

    const clean = folderWith(compose);
    const key = fakeAccessKeyId();
    const leaked = folderWith(compose.replace(DEMO_SECRETS.JWT_SECRET, key));
    try {
      const first = await scan(clean);
      expect(first.code, first.log).toBe(0);
      expect(first.findings).toEqual([]);

      const second = await scan(leaked);
      expect(second.code, second.log).not.toBe(0);
      expect(second.findings).toHaveLength(1);
      const jwtLine =
        compose.split('\n').findIndex((line) => line.includes(DEMO_SECRETS.JWT_SECRET)) + 1;
      expect(second.findings[0]?.StartLine).toBe(jwtLine);
      expect(second.findings[0]?.RuleID).toBe('aws-access-token');
      // Redacted: the generated value never reaches the output.
      expect(JSON.stringify(second.findings)).not.toContain(key);
      expect(second.log).not.toContain(key);
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(leaked, { recursive: true, force: true });
    }

    // The allowlist, if any: anchored regular expressions, each matching exactly one value of the
    // list DEP-R36 names; a new entry fails here until that list is changed on purpose.
    expect(readRepositoryFile('docs/api/openapi.yaml')).toContain(OPENAPI_EXAMPLE_KEY);
    if (!existsSync(join(REPOSITORY_ROOT, '.gitleaks.toml'))) return;
    expect(allowlistProblems(readRepositoryFile('.gitleaks.toml'))).toEqual([]);
  }, 120_000);

  it('DEP-AC25 the allowlist check accepts only the lines DEP-R36 allows, and refuses stopwords, a legacy [allowlist] table, paths and any other key', () => {
    const config = readRepositoryFile('.gitleaks.toml');
    expect(allowlistProblems(config)).toEqual([]);

    for (const added of [
      'stopwords = ["demo"]',
      '[allowlist]',
      "paths = ['''compose.yaml''']",
      'commits = ["0123abcd"]',
      'disabledRules = ["generic-api-key"]',
      'condition = "AND"',
      'regexTarget = "match"',
      '[[rules]]',
      'useDefault = false',
      "regexes = ['''^5b0d7f1e-6c2a-4e8b-9f3d-2a1c4e6b8d0f$''', '''^x$''']",
      "regexes = ['''demo-only-jwt-secret-for-docker-compose-00000000''']",
      "regexes = ['''^.*$''']",
      "regexes = ['''^(5b0d7f1e-6c2a-4e8b-9f3d-2a1c4e6b8d0f|AKIA[A-Z2-7]{16})$''']",
      "regexes = ['''^demo-only-jwt-secret-for-docker-compose-0000000.$''']",
    ]) {
      expect(allowlistProblems(`${config}\n${added}\n`), added).not.toEqual([]);
    }
  });
});
