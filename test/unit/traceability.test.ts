import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  linesOutsideFences,
  listFailures,
  parseArgs,
  parseSpec,
  parseTasks,
  run,
  type Output,
} from '../../scripts/traceability.js';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const CLI = join(REPO_ROOT, 'scripts/trace.ts');
const FIXTURES = join(REPO_ROOT, 'test/fixtures/traceability');
const PASSING = join(FIXTURES, 'passing');
const FAILING = join(FIXTURES, 'failing');
const INVALID = join(FIXTURES, 'invalid');

function capture(): Output & { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { logs, errors, log: (line) => logs.push(line), error: (line) => errors.push(line) };
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

describe('traceability: spec parsing', () => {
  it('reads the status, the ID prefix and each AC with its level and Verified by line', () => {
    expect(parseSpec('001-alpha', read(PASSING, 'specs/001-alpha/spec.md'))).toEqual({
      spec: {
        name: '001-alpha',
        status: 'Implemented',
        prefix: 'ZZA',
        acs: [
          { id: 'ZZA-AC01', spec: '001-alpha', level: 'unit', verifiedBy: undefined },
          {
            id: 'ZZA-AC02',
            spec: '001-alpha',
            level: 'ci',
            verifiedBy: 'CI job `terraform` (terraform validate)',
          },
          { id: 'ZZA-AC03', spec: '001-alpha', level: 'integration', verifiedBy: undefined },
          { id: 'ZZA-AC04', spec: '001-alpha', level: 'unit', verifiedBy: undefined },
        ],
      },
      problems: [],
    });
  });

  it('treats an empty Verified by line as absent', () => {
    const acs = parseSpec('001-gamma', read(FAILING, 'specs/001-gamma/spec.md')).spec.acs;

    expect(acs.find((ac) => ac.id === 'ZZC-AC02')).toMatchObject({
      level: 'ci',
      verifiedBy: undefined,
    });
  });

  it('reports a missing status, an unknown status and a missing ID prefix', () => {
    expect(parseSpec('x', '# X\n').problems).toEqual([
      'has no "- **Status:**" line',
      'has no "- **ID prefix:**" line',
    ]);
    expect(
      parseSpec('x', '- **Status:** Draft | Approved\n- **ID prefix:** ZZH\n').problems,
    ).toEqual(['has status "Draft | Approved"; expected Draft, Approved, Implemented']);
  });

  it('reports mistyped AC headings, foreign prefixes, bad levels and a Verified by line on a non-ci AC', () => {
    expect(parseSpec('003-three', read(INVALID, 'specs/003-three/spec.md')).problems).toEqual([
      'line 6: "### ZZI-AC01: a colon instead of a space" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'line 8: "#### ZZI-AC02 · a level-4 heading" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'line 10: "### ZZI-AC3 · one digit" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'line 12: "###ZZI-AC04 · no space after the hashes" looks like an AC heading but is not "### PFX-ACnn · Title"',
      "ZZJ-AC05 does not use the spec's ID prefix ZZI",
      'ZZI-AC06 has level "integraton"; expected unit, integration, e2e, ci',
      'ZZI-AC07 has no "- **Level:**" line',
      'ZZI-AC08 has a "Verified by" line but its level is not ci',
    ]);
  });

  it('ignores headings in code fences, closing a fence only with the same character, at least as long', () => {
    expect(
      parseSpec('003-three', read(INVALID, 'specs/003-three/spec.md')).spec.acs.map((ac) => ac.id),
    ).toEqual(['ZZJ-AC05', 'ZZI-AC06', 'ZZI-AC07', 'ZZI-AC08', 'ZZI-AC09']);
    expect(
      parseSpec('001-alpha', read(PASSING, 'specs/001-alpha/spec.md')).spec.acs.map((ac) => ac.id),
    ).not.toContain('ZZA-AC99');
  });

  it('reports a code fence that is never closed', () => {
    const parsed = parseSpec('004-four', read(INVALID, 'specs/004-four/spec.md'));

    expect(parsed.problems).toContain(
      'line 10: code fence is never closed, so everything after it is ignored',
    );
    expect(parsed.spec.acs.map((ac) => ac.id)).toEqual(['ZZK-AC01']);
    expect(linesOutsideFences('```\nclosed\n```\n').unclosedFenceAt).toBeUndefined();
  });

  it('accepts CRLF line endings', () => {
    const content =
      '- **Status:** Draft\r\n- **ID prefix:** ZZH\r\n\r\n### ZZH-AC01 · Title\r\n\r\n- **Level:** ci\r\n';

    expect(parseSpec('x', content)).toMatchObject({
      spec: { status: 'Draft', acs: [{ id: 'ZZH-AC01', level: 'ci' }] },
      problems: [],
    });
  });
});

describe('traceability: tasks', () => {
  it('reads ticked and open tasks that name AC IDs', () => {
    const file = 'specs/002-delta/tasks.md';

    expect(parseTasks(file, read(FAILING, file))).toEqual({
      tasks: [
        { ids: ['ZZD-AC01'], ticked: true, file, line: 3 },
        { ids: ['ZZD-AC09'], ticked: false, file, line: 4 },
      ],
      problems: [],
    });
  });

  it('reports other checkbox list forms and AC IDs outside a task line', () => {
    const file = 'specs/003-three/tasks.md';
    const parsed = parseTasks(file, read(INVALID, file));

    expect(parsed.problems).toEqual([
      "line 3: ZZI-AC08 is not on a task's checkbox line, so no task enforces it",
      "line 6: ZZI-AC09 is not on a task's checkbox line, so no task enforces it",
      'line 8: "* [x] T3 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
      'line 9: "1. [x] T4 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
      'line 10: "- [X] T5 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
    ]);
    expect(parsed.tasks.map(({ ids, ticked }) => [ids, ticked])).toEqual([[['ZZI-AC06'], false]]);
  });
});

describe('traceability: report', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('covers an AC only with a passing test of its level, and reports the others as pending', () => {
    const report = buildReport(PASSING);

    expect(report.reports).toEqual(['unit', 'integration']);
    expect(report.rows.map(({ id, coverage, tests }) => [id, coverage, tests])).toEqual([
      ['ZZA-AC01', 'covered', ['test/unit/alpha.test.ts']],
      ['ZZA-AC02', 'covered', []],
      ['ZZA-AC03', 'covered', ['test/integration/alpha.test.ts']],
      ['ZZA-AC04', 'covered', ['test/unit/alpha.test.ts']],
      ['ZZB-AC01', 'pending', []],
      ['ZZB-AC02', 'covered', ['test/integration/beta.test.ts']],
      ['ZZB-AC03', 'pending', []],
    ]);
    expect(report.rows.find((row) => row.id === 'ZZB-AC01')?.notPassed).toEqual([
      {
        fullName: 'ZZB-AC01 not ready yet, but its spec is a draft',
        status: 'skipped',
        file: 'test/integration/beta.test.ts',
      },
    ]);
    expect(listFailures(report, ['unit', 'integration'])).toEqual([]);
    expect(run(['--require', 'unit,integration'], PASSING, capture())).toBe(0);
  });

  it('fails on required ACs without a passing test of their level, or named by any test that did not pass, and on undefined IDs', () => {
    const output = capture();

    expect(run([], FAILING, output)).toBe(1);
    expect(output.errors).toEqual([
      'FAIL specs/002-delta/tasks.md line 4 names ZZD-AC09, which no spec defines',
      'FAIL ZZC-AC01 (specs/001-gamma, Implemented) has no passing unit test whose name contains its ID',
      'FAIL ZZC-AC02 (specs/001-gamma, Implemented, level ci) has no "- **Verified by:**" line',
      'FAIL ZZC-AC03 (specs/001-gamma, Implemented, level ci) has no "- **Verified by:**" line',
      'FAIL ZZC-AC04 (specs/001-gamma, Implemented) has no passing unit test whose name contains its ID',
      'FAIL ZZC-AC06 (specs/001-gamma, Implemented) has no passing integration test whose name contains its ID',
      'FAIL ZZD-AC01 (specs/002-delta, ticked in specs/002-delta/tasks.md) has no passing unit test whose name contains its ID',
      'FAIL ZZC-AC04 (specs/001-gamma, Implemented) is named by a test that did not pass: "ZZC-AC04 is skipped" (skipped, test/unit/gamma.test.ts)',
      'FAIL ZZC-AC04 (specs/001-gamma, Implemented) is named by a test that did not pass: "ZZC-AC04 is todo" (todo, test/unit/gamma.test.ts)',
      'FAIL ZZC-AC04 (specs/001-gamma, Implemented) is named by a test that did not pass: "ZZC-AC04 fails" (failed, test/unit/gamma.test.ts)',
      'FAIL ZZC-AC08 (specs/001-gamma, Implemented) is named by a test that did not pass: "ZZC-AC08 the half that is switched off" (skipped, test/unit/gamma.test.ts)',
      'FAIL ZZE-AC01 is named by test/unit/gamma.test.ts but no spec defines it',
      'FAIL ZZE-AC02 is named by test/unit/gamma.test.ts but no spec defines it',
    ]);
  });

  it('marks ACs whose report is absent as unverified, and fails on them only with --require', () => {
    const report = buildReport(FAILING);

    expect(report.rows.find((row) => row.id === 'ZZC-AC07')?.coverage).toBe('unverified');
    expect(listFailures(report)).not.toContainEqual(expect.stringContaining('ZZC-AC07'));
    expect(listFailures(report, ['e2e'])).toContain(
      'reports/vitest-e2e.json is missing: the e2e tests were not run, and --require needs them',
    );
  });

  it('fails on malformed specs, tasks and reports even when every spec is a draft', () => {
    const output = capture();

    expect(run([], INVALID, output)).toBe(1);
    expect(output.errors).toEqual([
      'FAIL specs/001-one/spec.md has status "Done"; expected Draft, Approved, Implemented',
      'FAIL specs/002-two/spec.md has no "- **Status:**" line',
      'FAIL specs/003-three/spec.md line 6: "### ZZI-AC01: a colon instead of a space" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'FAIL specs/003-three/spec.md line 8: "#### ZZI-AC02 · a level-4 heading" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'FAIL specs/003-three/spec.md line 10: "### ZZI-AC3 · one digit" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'FAIL specs/003-three/spec.md line 12: "###ZZI-AC04 · no space after the hashes" looks like an AC heading but is not "### PFX-ACnn · Title"',
      "FAIL specs/003-three/spec.md ZZJ-AC05 does not use the spec's ID prefix ZZI",
      'FAIL specs/003-three/spec.md ZZI-AC06 has level "integraton"; expected unit, integration, e2e, ci',
      'FAIL specs/003-three/spec.md ZZI-AC07 has no "- **Level:**" line',
      'FAIL specs/003-three/spec.md ZZI-AC08 has a "Verified by" line but its level is not ci',
      "FAIL specs/003-three/tasks.md line 3: ZZI-AC08 is not on a task's checkbox line, so no task enforces it",
      "FAIL specs/003-three/tasks.md line 6: ZZI-AC09 is not on a task's checkbox line, so no task enforces it",
      'FAIL specs/003-three/tasks.md line 8: "* [x] T3 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
      'FAIL specs/003-three/tasks.md line 9: "1. [x] T4 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
      'FAIL specs/003-three/tasks.md line 10: "- [X] T5 Build ZZI-AC07" is not a task line; write tasks as "- [ ]" or "- [x]"',
      'FAIL specs/004-four/spec.md line 10: code fence is never closed, so everything after it is ignored',
      "FAIL specs/004-four/spec.md ZZK-AC01 does not use the spec's ID prefix ZZI",
      'FAIL specs/005-five has no spec.md',
      'FAIL ID prefix ZZG is used by specs/001-one and specs/002-two',
      'FAIL ID prefix ZZI is used by specs/003-three and specs/004-four',
      'FAIL reports/vitest-unit.json is not a Vitest JSON report',
      'FAIL ZZG-AC01 is defined more than once (specs/001-one and specs/002-two)',
    ]);
  });

  it('passes with no specs/ folder and with an empty specs/ folder', () => {
    const output = capture();
    expect(run([], dir, output)).toBe(0);
    expect(output.logs).toContain(
      '0 ACs in 0 specs: 0 covered, 0 pending, 0 missing, 0 unverified. Test reports read: none.',
    );

    mkdirSync(join(dir, 'specs'));
    writeFileSync(join(dir, 'specs/README.md'), '# Specs\n');
    expect(run([], dir, capture())).toBe(0);
  });

  it('writes docs/traceability.md with --write, identical on every run', () => {
    cpSync(PASSING, dir, { recursive: true });

    expect(run(['--write'], dir, capture())).toBe(0);
    const first = read(dir, 'docs/traceability.md');
    expect(run(['--write'], dir, capture())).toBe(0);

    expect(read(dir, 'docs/traceability.md')).toBe(first);
    expect(first).toContain(
      '| ZZA-AC02 | 001-alpha | Implemented | ci | covered | Verified by: CI job `terraform` (terraform validate) |',
    );
    expect(first).toContain(
      '| ZZB-AC02 | 002-beta | Draft, task ticked | integration | covered | test/integration/beta.test.ts |',
    );
    expect(first).toContain('7 ACs in 2 specs: 5 covered, 2 pending, 0 missing, 0 unverified.');
  });
});

describe('traceability: command line', () => {
  it('parses --write and --require in both forms, and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ write: false, require: [] });
    expect(parseArgs(['--write', '--require', 'unit,integration'])).toEqual({
      write: true,
      require: ['unit', 'integration'],
    });
    expect(parseArgs(['--require=e2e'])).toEqual({ write: false, require: ['e2e'] });
    expect(parseArgs(['--require', 'unit,smoke'])).toBe('Unknown project for --require: "smoke"');
    expect(parseArgs(['--require'])).toBe('Unknown argument: --require');
    expect(parseArgs(['--wirte'])).toBe('Unknown argument: --wirte');
  });

  it('answers bad usage with exit code 2', () => {
    const output = capture();

    expect(run(['--wirte'], PASSING, output)).toBe(2);
    expect(output.errors[0]).toMatch(/^Unknown argument: --wirte\. Usage:/);
  });

  it(
    'exits 1 on the failing fixture and 0 on the passing one when run as a command',
    { timeout: 20_000 },
    () => {
      const runCli = (cwd: string): number | null =>
        spawnSync(process.execPath, ['--import', 'tsx', CLI], { cwd, encoding: 'utf8' }).status;

      expect(runCli(FAILING)).toBe(1);
      expect(runCli(PASSING)).toBe(0);
    },
  );
});
