import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';

export const SPEC_STATUSES = ['Draft', 'Approved', 'Implemented'] as const;
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** Vitest projects whose JSON reports prove ACs; each one matches the AC level of the same name. */
export const PROJECTS = ['unit', 'integration', 'e2e'] as const;
export type Project = (typeof PROJECTS)[number];
export const AC_LEVELS = [...PROJECTS, 'ci'] as const;

const OUTPUT_FILE = 'docs/traceability.md';
const SPEC_FOLDER = /^\d{3}-/;

const AC_ID = /\b[A-Z][A-Z0-9]*-AC\d{2}\b/g;
const AC_HEADING = /^###\s+([A-Z][A-Z0-9]*-AC\d{2})(?=\s|$)/;
// Any heading that starts like an AC ID, so a mistyped one is reported instead of dropped.
const AC_LIKE_HEADING = /^#{1,6}\s*[A-Z][A-Z0-9]*-AC\d/;
// An AC block ends at the next heading of level 1 to 3.
const BLOCK_END = /^#{1,3}\s/;
// CommonMark fences: up to three spaces of indent, then three or more backticks or tildes.
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const STATUS_LINE = /^-\s+\*\*Status:\*\*(.*)$/;
const PREFIX_LINE = /^-\s+\*\*ID prefix:\*\*(.*)$/;
const LEVEL_LINE = /^-\s+\*\*Level:\*\*(.*)$/;
const VERIFIED_BY_LINE = /^-\s+\*\*Verified by:\*\*(.*)$/;
// Tasks are "- [ ]" or "- [x]" lines; any other list item holding a checkbox is a problem.
const TASK_LINE = /^\s*- \[( |x)\](?:\s|$)/;
const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s*\[[^\]]?\]/;

/** The parts of a Vitest JSON report the gate reads. */
const VitestReport = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
    }),
  ),
});

export interface AcDefinition {
  id: string;
  /** Spec folder name, for example "003-movements". */
  spec: string;
  level: string | undefined;
  verifiedBy: string | undefined;
}

export interface ParsedSpec {
  name: string;
  status: SpecStatus | undefined;
  prefix: string | undefined;
  acs: AcDefinition[];
}

/** A task line of a tasks.md file that names AC IDs. */
export interface TaskReference {
  ids: string[];
  ticked: boolean;
  file: string;
  line: number;
}

/** One test from a Vitest JSON report. */
export interface TestResult {
  project: Project;
  /** Describe titles plus the test's own title, as Vitest reports it. */
  fullName: string;
  /** passed, failed, skipped, todo or pending. */
  status: string;
  file: string;
}

/**
 * covered: proven by a passing test of the AC's level, or a Verified by line for level ci.
 * pending: not proven and not required yet. missing: required and not proven.
 * unverified: the report of the AC's project is absent, so its project was not run.
 */
export type Coverage = 'covered' | 'pending' | 'missing' | 'unverified';

export interface AcRow extends AcDefinition {
  status: SpecStatus | undefined;
  /** tasks.md files with a ticked task naming this AC. */
  tickedIn: string[];
  coverage: Coverage;
  /** Test files with a passing test that names this AC, in the report of its level. */
  tests: string[];
  /** Tests in any report that name this AC and did not pass: skipped, todo or failed. */
  notPassed: { fullName: string; status: string; file: string }[];
}

export interface TraceReport {
  specCount: number;
  rows: AcRow[];
  /** Projects whose JSON report was found. */
  reports: Project[];
  /** AC IDs named by reported tests that no spec defines, with the files that name them. */
  unknownMentions: { id: string; files: string[] }[];
  /** Malformed specs, tasks and reports. */
  problems: string[];
}

export interface Options {
  write: boolean;
  /** Projects whose report must exist; without one the gate fails. */
  require: Project[];
}

function isSpecStatus(value: string): value is SpecStatus {
  return (SPEC_STATUSES as readonly string[]).includes(value);
}

function isProject(value: string): value is Project {
  return (PROJECTS as readonly string[]).includes(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

export function isCiLevel(ac: Pick<AcDefinition, 'level'>): boolean {
  return ac.level === 'ci';
}

export function reportPath(project: Project): string {
  return `reports/vitest-${project}.json`;
}

/**
 * The lines of a Markdown document outside fenced code blocks, with 1-based numbers, and the line
 * of a fence that is never closed. A fence closes only with the same character repeated at least
 * as many times, and nothing after it.
 */
export function linesOutsideFences(content: string): {
  lines: { text: string; number: number }[];
  unclosedFenceAt: number | undefined;
} {
  const lines: { text: string; number: number }[] = [];
  let fence: { marker: string; line: number } | undefined;
  content.split(/\r?\n/).forEach((text, index) => {
    const match = FENCE_LINE.exec(text);
    const marker = match?.[1];
    if (fence === undefined) {
      if (marker === undefined) lines.push({ text, number: index + 1 });
      else fence = { marker, line: index + 1 };
    } else if (
      marker !== undefined &&
      marker[0] === fence.marker[0] &&
      marker.length >= fence.marker.length &&
      (match?.[2] ?? '').trim() === ''
    ) {
      fence = undefined;
    }
  });
  return { lines, unclosedFenceAt: fence?.line };
}

function unclosedFenceProblem(line: number | undefined): string[] {
  return line === undefined
    ? []
    : [`line ${String(line)}: code fence is never closed, so everything after it is ignored`];
}

export function parseSpec(name: string, content: string): { spec: ParsedSpec; problems: string[] } {
  const acs: AcDefinition[] = [];
  const { lines, unclosedFenceAt } = linesOutsideFences(content);
  const problems = unclosedFenceProblem(unclosedFenceAt);
  let statusText: string | undefined;
  let prefix: string | undefined;
  let current: AcDefinition | undefined;

  for (const { text, number } of lines) {
    const id = AC_HEADING.exec(text)?.[1];
    if (id === undefined && AC_LIKE_HEADING.test(text)) {
      problems.push(
        `line ${String(number)}: "${text.trim()}" looks like an AC heading but is not "### PFX-ACnn · Title"`,
      );
    }
    if (BLOCK_END.test(text)) {
      current =
        id === undefined ? undefined : { id, spec: name, level: undefined, verifiedBy: undefined };
      if (current !== undefined) acs.push(current);
      continue;
    }

    statusText ??= nonEmpty(STATUS_LINE.exec(text)?.[1]);
    prefix ??= nonEmpty(PREFIX_LINE.exec(text)?.[1]);
    if (current === undefined) continue;
    current.level ??= nonEmpty(LEVEL_LINE.exec(text)?.[1]);
    current.verifiedBy ??= nonEmpty(VERIFIED_BY_LINE.exec(text)?.[1]);
  }

  let status: SpecStatus | undefined;
  if (statusText === undefined) {
    problems.push('has no "- **Status:**" line');
  } else if (isSpecStatus(statusText)) {
    status = statusText;
  } else {
    problems.push(`has status "${statusText}"; expected ${SPEC_STATUSES.join(', ')}`);
  }
  if (prefix === undefined) problems.push('has no "- **ID prefix:**" line');

  for (const ac of acs) {
    if (prefix !== undefined && !ac.id.startsWith(`${prefix}-`)) {
      problems.push(`${ac.id} does not use the spec's ID prefix ${prefix}`);
    }
    if (ac.level === undefined) {
      problems.push(`${ac.id} has no "- **Level:**" line`);
    } else if (!(AC_LEVELS as readonly string[]).includes(ac.level)) {
      problems.push(`${ac.id} has level "${ac.level}"; expected ${AC_LEVELS.join(', ')}`);
    }
    if (ac.verifiedBy !== undefined && !isCiLevel(ac)) {
      problems.push(`${ac.id} has a "Verified by" line but its level is not ci`);
    }
  }

  return { spec: { name, status, prefix, acs }, problems };
}

/**
 * Task lines of a tasks.md file that name AC IDs. A task is a "- [ ]" or "- [x]" line, and it
 * names its AC IDs on that line. Any other list item with a checkbox, and any AC ID outside a
 * task line, is a problem: the gate would not enforce it.
 */
export function parseTasks(
  file: string,
  content: string,
): { tasks: TaskReference[]; problems: string[] } {
  const tasks: TaskReference[] = [];
  const { lines, unclosedFenceAt } = linesOutsideFences(content);
  const problems = unclosedFenceProblem(unclosedFenceAt);

  for (const { text, number } of lines) {
    const mark = TASK_LINE.exec(text)?.[1];
    const ids = [...new Set([...text.matchAll(AC_ID)].map(([id]) => id))];
    if (mark !== undefined) {
      if (ids.length > 0) tasks.push({ ids, ticked: mark === 'x', file, line: number });
    } else if (CHECKBOX_LINE.test(text)) {
      problems.push(
        `line ${String(number)}: "${text.trim()}" is not a task line; write tasks as "- [ ]" or "- [x]"`,
      );
    } else if (ids.length > 0) {
      problems.push(
        `line ${String(number)}: ${ids.join(', ')} is not on a task's checkbox line, so no task enforces it`,
      );
    }
  }
  return { tasks, problems };
}

/** Reads specs/<name>/spec.md and tasks.md for every folder in specs/. No specs/ means no specs. */
export function loadSpecs(root: string): {
  specs: ParsedSpec[];
  tasks: TaskReference[];
  problems: string[];
} {
  const specsDir = join(root, 'specs');
  const specs: ParsedSpec[] = [];
  const tasks: TaskReference[] = [];
  const problems: string[] = [];
  if (!existsSync(specsDir)) return { specs, tasks, problems };

  const folders = readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of folders) {
    // Compare names exactly: existsSync would find "Spec.md" on a case-insensitive file system.
    const files = readdirSync(join(specsDir, name));
    if (!files.includes('spec.md')) {
      if (SPEC_FOLDER.test(name)) problems.push(`specs/${name} has no spec.md`);
      continue;
    }
    const parsed = parseSpec(name, readFileSync(join(specsDir, name, 'spec.md'), 'utf8'));
    specs.push(parsed.spec);
    problems.push(...parsed.problems.map((problem) => `specs/${name}/spec.md ${problem}`));

    if (files.includes('tasks.md')) {
      const file = `specs/${name}/tasks.md`;
      const parsedTasks = parseTasks(file, readFileSync(join(root, file), 'utf8'));
      tasks.push(...parsedTasks.tasks);
      problems.push(...parsedTasks.problems.map((problem) => `${file} ${problem}`));
    }
  }

  const prefixOwners = new Map<string, string>();
  for (const spec of specs) {
    if (spec.prefix === undefined) continue;
    const first = prefixOwners.get(spec.prefix);
    if (first === undefined) prefixOwners.set(spec.prefix, spec.name);
    else problems.push(`ID prefix ${spec.prefix} is used by specs/${first} and specs/${spec.name}`);
  }
  return { specs, tasks, problems };
}

function displayPath(root: string, file: string): string {
  if (!isAbsolute(file)) return file;
  const path = relative(root, file);
  return path.startsWith('..') ? file : path.split(sep).join('/');
}

/** Reads the JSON report of each project that has one under reports/. */
export function loadReports(root: string): {
  results: TestResult[];
  found: Project[];
  problems: string[];
} {
  const results: TestResult[] = [];
  const found: Project[] = [];
  const problems: string[] = [];
  for (const project of PROJECTS) {
    const path = join(root, reportPath(project));
    if (!existsSync(path)) continue;
    let parsed: z.infer<typeof VitestReport>;
    try {
      parsed = VitestReport.parse(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      problems.push(`${reportPath(project)} is not a Vitest JSON report`);
      continue;
    }
    found.push(project);
    for (const file of parsed.testResults) {
      for (const { fullName, status } of file.assertionResults) {
        results.push({ project, fullName, status, file: displayPath(root, file.name) });
      }
    }
  }
  return { results, found, problems };
}

export function buildReport(root: string): TraceReport {
  const { specs, tasks, problems } = loadSpecs(root);
  const reports = loadReports(root);
  problems.push(...reports.problems);

  const levelOf = new Map<string, string | undefined>();
  const definedIn = new Map<string, string>();
  for (const spec of specs) {
    for (const ac of spec.acs) {
      const first = definedIn.get(ac.id);
      if (first === undefined) {
        definedIn.set(ac.id, spec.name);
        levelOf.set(ac.id, ac.level);
      } else {
        problems.push(`${ac.id} is defined more than once (specs/${first} and specs/${spec.name})`);
      }
    }
  }

  const tickedIn = new Map<string, Set<string>>();
  for (const task of tasks) {
    for (const id of task.ids) {
      if (!definedIn.has(id)) {
        problems.push(`${task.file} line ${String(task.line)} names ${id}, which no spec defines`);
      } else if (task.ticked) {
        tickedIn.set(id, (tickedIn.get(id) ?? new Set<string>()).add(task.file));
      }
    }
  }

  // Only a passing test in the report of the AC's own level proves it. Tests that did not pass
  // are kept too: for a required AC, any of them fails the gate.
  const proving = new Map<string, Set<string>>();
  const notPassed = new Map<string, AcRow['notPassed']>();
  const unknown = new Map<string, Set<string>>();
  for (const result of reports.results) {
    for (const id of new Set([...result.fullName.matchAll(AC_ID)].map(([match]) => match))) {
      if (!definedIn.has(id)) {
        unknown.set(id, (unknown.get(id) ?? new Set<string>()).add(result.file));
      } else if (result.status !== 'passed') {
        const { fullName, status, file } = result;
        notPassed.set(id, [...(notPassed.get(id) ?? []), { fullName, status, file }]);
      } else if (levelOf.get(id) === result.project) {
        proving.set(id, (proving.get(id) ?? new Set<string>()).add(result.file));
      }
    }
  }

  const rows = specs.flatMap((spec) =>
    spec.acs.map((ac): AcRow => {
      const tests = [...(proving.get(ac.id) ?? [])].sort();
      const ticked = [...(tickedIn.get(ac.id) ?? [])].sort();
      const required = spec.status === 'Implemented' || ticked.length > 0;
      const level = ac.level ?? '';
      let coverage: Coverage;
      if (isCiLevel(ac)) {
        coverage = ac.verifiedBy !== undefined ? 'covered' : required ? 'missing' : 'pending';
      } else if (isProject(level) && !reports.found.includes(level)) {
        coverage = 'unverified';
      } else {
        coverage = tests.length > 0 ? 'covered' : required ? 'missing' : 'pending';
      }
      return {
        ...ac,
        status: spec.status,
        tickedIn: ticked,
        coverage,
        tests,
        notPassed: notPassed.get(ac.id) ?? [],
      };
    }),
  );

  const unknownMentions = [...unknown]
    .map(([id, files]) => ({ id, files: [...files].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { specCount: specs.length, rows, reports: reports.found, unknownMentions, problems };
}

/** Everything that makes the check fail, one message per line. */
export function listFailures(report: TraceReport, required: readonly Project[] = []): string[] {
  const absent = required
    .filter((project) => !report.reports.includes(project))
    .map(
      (project) =>
        `${reportPath(project)} is missing: the ${project} tests were not run, and --require needs them`,
    );
  const reasonOf = (row: AcRow): string =>
    row.status === 'Implemented' ? 'Implemented' : `ticked in ${row.tickedIn.join(', ')}`;
  const isRequired = (row: AcRow): boolean =>
    row.status === 'Implemented' || row.tickedIn.length > 0;
  const missing = report.rows
    .filter((row) => row.coverage === 'missing')
    .map((row) =>
      isCiLevel(row)
        ? `${row.id} (specs/${row.spec}, ${reasonOf(row)}, level ci) has no "- **Verified by:**" line`
        : `${row.id} (specs/${row.spec}, ${reasonOf(row)}) has no passing ${row.level ?? '?'} test whose name contains its ID`,
    );
  const notPassed = report.rows
    .filter(isRequired)
    .flatMap((row) =>
      row.notPassed.map(
        ({ fullName, status, file }) =>
          `${row.id} (specs/${row.spec}, ${reasonOf(row)}) is named by a test that did not pass: "${fullName}" (${status}, ${file})`,
      ),
    );
  const unknown = report.unknownMentions.map(
    ({ id, files }) => `${id} is named by ${files.join(', ')} but no spec defines it`,
  );
  return [...report.problems, ...absent, ...missing, ...notPassed, ...unknown];
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function proofOf(row: AcRow): string {
  if (isCiLevel(row)) return `Verified by: ${row.verifiedBy ?? '-'}`;
  if (row.coverage === 'unverified') return `not run (${reportPath(row.level as Project)} missing)`;
  return row.tests.length > 0 ? row.tests.join(', ') : '-';
}

export function renderTable(report: TraceReport): string {
  const lines = [
    '| AC | Spec | Status | Level | Coverage | Proof |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of report.rows) {
    const status = `${row.status ?? '?'}${row.tickedIn.length > 0 ? ', task ticked' : ''}`;
    const cells = [row.id, row.spec, status, row.level ?? '?', row.coverage, proofOf(row)];
    lines.push(`| ${cells.map(cell).join(' | ')} |`);
  }
  return lines.join('\n');
}

export function renderSummary(report: TraceReport): string {
  const count = (coverage: Coverage): string =>
    String(report.rows.filter((row) => row.coverage === coverage).length);
  const reports = report.reports.length > 0 ? report.reports.join(', ') : 'none';
  return (
    `${String(report.rows.length)} ACs in ${String(report.specCount)} specs: ` +
    `${count('covered')} covered, ${count('pending')} pending, ${count('missing')} missing, ` +
    `${count('unverified')} unverified. Test reports read: ${reports}.`
  );
}

export function renderDocument(report: TraceReport): string {
  return [
    '# Traceability',
    '',
    'Generated by `npm run trace -- --write` from `specs/*/spec.md`, `specs/*/tasks.md` and the Vitest JSON reports in `reports/`. Do not edit by hand.',
    '',
    renderTable(report),
    '',
    renderSummary(report),
    '',
  ].join('\n');
}

/** Parses the command line; returns an error message for bad usage. */
export function parseArgs(args: readonly string[]): Options | string {
  const options: Options = { write: false, require: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--write') {
      options.write = true;
      continue;
    }
    const inline = /^--require=(.*)$/.exec(arg)?.[1];
    const value = inline ?? (arg === '--require' ? args[(index += 1)] : undefined);
    if (value === undefined) return `Unknown argument: ${arg}`;
    for (const name of value.split(',')) {
      if (!isProject(name)) return `Unknown project for --require: "${name}"`;
      options.require.push(name);
    }
  }
  return options;
}

export interface Output {
  log: (line: string) => void;
  error: (line: string) => void;
}

const USAGE = 'Usage: npm run trace [-- [--write] [--require unit,integration,e2e]]';

/** Runs the check from root and returns the exit code: 0 pass, 1 fail, 2 bad usage. */
export function run(args: readonly string[], root: string, output: Output = console): number {
  const options = parseArgs(args);
  if (typeof options === 'string') {
    output.error(`${options}. ${USAGE}`);
    return 2;
  }

  const report = buildReport(root);
  output.log(renderTable(report));
  output.log('');
  output.log(renderSummary(report));

  if (options.write) {
    const path = join(root, OUTPUT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderDocument(report));
    output.log(`Wrote ${OUTPUT_FILE}`);
  }

  const failures = listFailures(report, options.require);
  for (const failure of failures) output.error(`FAIL ${failure}`);
  return failures.length > 0 ? 1 : 0;
}
