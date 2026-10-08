import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildReport,
  ciGapsOf,
  linesOutsideFences,
  listFailures,
  npmRunScripts,
  provenScripts,
  parseArgs,
  parseSpec,
  parseTasks,
  run,
  workflowCommands,
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
            verifiedBy: 'CI job `terraform`, step `npm run zz-terraform-validate`',
          },
          { id: 'ZZA-AC03', spec: '001-alpha', level: 'integration', verifiedBy: undefined },
          { id: 'ZZA-AC04', spec: '001-alpha', level: 'unit', verifiedBy: undefined },
          {
            id: 'ZZA-AC05',
            spec: '001-alpha',
            level: 'ci',
            verifiedBy: 'CI job `ci`, step `npm run zz-check`, run after `npm run zz:prepare`.',
          },
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
      'line 51: "### zzi-ac11 · lowercase" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'line 53: "### ZZI-AC12 · indented by four spaces, a code block" looks like an AC heading but is not "### PFX-ACnn · Title"',
      "ZZJ-AC05 does not use the spec's ID prefix ZZI",
      'ZZI-AC06 has level "integraton"; expected unit, integration, e2e, ci',
      'ZZI-AC07 has no "- **Level:**" line',
      'ZZI-AC08 has a "Verified by" line but its level is not ci',
    ]);
  });

  it('parses AC headings indented by up to three spaces, and reports AC-like headings in any case or deeper indent', () => {
    const parsed = parseSpec('003-three', read(INVALID, 'specs/003-three/spec.md'));

    expect(parsed.spec.acs.find((ac) => ac.id === 'ZZI-AC10')).toMatchObject({ level: 'unit' });
    expect(parsed.problems).toEqual(
      expect.arrayContaining([
        'line 51: "### zzi-ac11 · lowercase" looks like an AC heading but is not "### PFX-ACnn · Title"',
        'line 53: "### ZZI-AC12 · indented by four spaces, a code block" looks like an AC heading but is not "### PFX-ACnn · Title"',
      ]),
    );
  });

  it('ignores headings in code fences, closing a fence only with the same character, at least as long', () => {
    expect(
      parseSpec('003-three', read(INVALID, 'specs/003-three/spec.md')).spec.acs.map((ac) => ac.id),
    ).toEqual(['ZZJ-AC05', 'ZZI-AC06', 'ZZI-AC07', 'ZZI-AC08', 'ZZI-AC09', 'ZZI-AC10']);
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
      ['ZZA-AC05', 'covered', []],
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
      'FAIL ZZC-AC09 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-absent is not a script in package.json; npm run zz-absent is not run by a step of .github/workflows/ci.yml that can fail the build',
      'FAIL ZZC-AC10 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-commented is not run by a step of .github/workflows/ci.yml that can fail the build',
      'FAIL ZZC-AC11 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-step-only is not a script in package.json',
      'FAIL ZZC-AC12 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: it names no npm run script that a step of .github/workflows/ci.yml runs',
      'FAIL ZZC-AC13 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-or-true is not run by a step of .github/workflows/ci.yml that can fail the build',
      'FAIL ZZC-AC14 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-continue is not run by a step of .github/workflows/ci.yml that can fail the build',
      'FAIL ZZC-AC15 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-if-false is not run by a step of .github/workflows/ci.yml that can fail the build',
      'FAIL ZZC-AC16 (specs/001-gamma, Implemented, level ci) is not proven by its Verified by line: npm run zz-job-off is not run by a step of .github/workflows/ci.yml that can fail the build',
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
      'FAIL specs/003-three/spec.md line 51: "### zzi-ac11 · lowercase" looks like an AC heading but is not "### PFX-ACnn · Title"',
      'FAIL specs/003-three/spec.md line 53: "### ZZI-AC12 · indented by four spaces, a code block" looks like an AC heading but is not "### PFX-ACnn · Title"',
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
      '| ZZA-AC02 | 001-alpha | Implemented | ci | covered | Verified by: CI job `terraform`, step `npm run zz-terraform-validate` |',
    );
    expect(first).toContain(
      '| ZZB-AC02 | 002-beta | Draft, task ticked | integration | covered | test/integration/beta.test.ts |',
    );
    expect(first).toContain('8 ACs in 2 specs: 6 covered, 2 pending, 0 missing, 0 unverified.');
  });
});

describe('traceability: ci-level proof', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'trace-ci-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the commands of run steps, inline and in block scalars, without comments', () => {
    const workflow = [
      'steps:',
      '  # - run: npm run commented-out',
      '  - run: npm run inline # npm run trailing-comment',
      '  - name: Block',
      '    run: |',
      '      # npm run shell-comment',
      '      DATABASE_URL=x npm run in-block',
      '',
      '      npm run after-blank-line',
      '      npm run or-else || true',
      '      npm run continued \\',
      '        --flag',
      '  - name: Next step',
      '    env:',
      '      NOTE: npm run not-a-command',
      '  - run: npm run step-continue',
      '    continue-on-error: true',
      '  - if: ${{ false }}',
      '    run: npm run step-if-false',
      '  - if: "false"',
      '    run: npm run step-if-false-quoted',
      '  - if: success()',
      '    continue-on-error: false',
      '    run: npm run step-kept',
    ].join('\n');

    expect(workflowCommands(workflow)).toEqual([
      'npm run inline',
      'DATABASE_URL=x npm run in-block',
      'npm run after-blank-line',
      'npm run or-else || true',
      'npm run continued --flag',
      'npm run step-kept',
    ]);
  });

  it('never counts a script with || anywhere after it as proof', () => {
    expect(provenScripts('npm run reconcile')).toEqual(['reconcile']);
    expect(provenScripts('DATABASE_URL=x npm run reconcile -- --json && npm run b')).toEqual([
      'reconcile',
      'b',
    ]);
    for (const command of [
      'npm run reconcile || true',
      'npm run reconcile ||:',
      'npm run reconcile || echo skipped',
      'npm run reconcile || exit 0',
      'npm run reconcile && npm run b || true',
      'npm run reconcile; npm run b || true',
    ]) {
      expect(provenScripts(command)).not.toContain('reconcile');
    }
    expect(provenScripts('npm run a || npm run b')).toEqual(['b']);

    const workflow = [
      'steps:',
      '  - run: |',
      '      npm run reconcile \\',
      '        || echo skipped',
      '  - run: npm run kept',
    ].join('\n');
    expect(workflowCommands(workflow).flatMap(provenScripts)).toEqual(['kept']);
  });

  it('leaves out every step of a job that may fail or never runs', () => {
    const workflow = [
      'jobs:',
      '  optional:',
      '    continue-on-error: true',
      '    steps:',
      '      - run: npm run in-optional-job',
      '  off:',
      '    if: false',
      '    steps:',
      '      - run: npm run in-disabled-job',
      '  required:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm run in-required-job',
    ].join('\n');

    expect(workflowCommands(workflow)).toEqual(['npm run in-required-job']);
  });

  it('finds every npm run script in a line, without a trailing full stop', () => {
    expect(
      npmRunScripts('step `npm run reconcile` after `npm run test:integration`, then npm run x.y.'),
    ).toEqual(['reconcile', 'test:integration', 'x.y']);
    expect(npmRunScripts('pnpm run other and CI job `terraform`')).toEqual([]);
  });

  it('proves a ci AC only when each script it names is in package.json and run by a CI step', () => {
    const context = {
      packageScripts: new Set(['both', 'package-only']),
      workflowScripts: new Set(['both', 'step-only']),
    };

    expect(ciGapsOf('`npm run both`; CI job `terraform`', context)).toEqual([]);
    expect(ciGapsOf('CI job `terraform` (terraform validate)', context)).toEqual([
      'it names no npm run script that a step of .github/workflows/ci.yml runs',
    ]);
    expect(ciGapsOf('npm run package-only, npm run step-only, npm run neither', context)).toEqual([
      'npm run package-only is not run by a step of .github/workflows/ci.yml that can fail the build',
      'npm run step-only is not a script in package.json',
      'npm run neither is not a script in package.json',
      'npm run neither is not run by a step of .github/workflows/ci.yml that can fail the build',
    ]);
  });

  it('fails a required ci AC once a script it names leaves package.json, and shows why', () => {
    const output = capture();
    cpSync(PASSING, dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"scripts": {"zz-check": "true"}}');

    expect(buildReport(dir).rows.find((row) => row.id === 'ZZA-AC05')).toMatchObject({
      coverage: 'missing',
      ciGaps: ['npm run zz:prepare is not a script in package.json'],
    });
    expect(run(['--write'], dir, output)).toBe(1);
    expect(read(dir, 'docs/traceability.md')).toContain(
      '(npm run zz:prepare is not a script in package.json) |',
    );

    writeFileSync(join(dir, 'package.json'), '{"scripts": ');
    expect(run([], dir, output)).toBe(1);
    expect(output.errors).toContain('FAIL package.json is not valid JSON with a "scripts" object');
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
