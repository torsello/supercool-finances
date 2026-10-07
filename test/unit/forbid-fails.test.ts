import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const VITEST = join(REPO_ROOT, 'node_modules/vitest/vitest.mjs');
const CONFIG = join(REPO_ROOT, 'test/fixtures/forbid-fails/vitest.config.ts');

interface Report {
  testResults: { assertionResults: { fullName: string; status: string }[] }[];
}

describe('forbid-fails setup file', () => {
  it(
    'fails every test marked fails, whatever the syntax, and leaves other tests alone',
    { timeout: 30_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'forbid-fails-'));
      try {
        const output = join(dir, 'report.json');
        const result = spawnSync(
          process.execPath,
          [VITEST, 'run', '--config', CONFIG, '--reporter=json', `--outputFile.json=${output}`],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        const report = JSON.parse(readFileSync(output, 'utf8')) as Report;
        const statuses = Object.fromEntries(
          report.testResults.flatMap((file) =>
            file.assertionResults.map(({ fullName, status }) => [fullName, status]),
          ),
        );

        expect(result.status).toBe(1);
        expect(statuses).toEqual({
          'fails modifier': 'failed',
          'fails option': 'failed',
          'suite with a fails option child': 'failed',
          'extended test with fails': 'failed',
          'chained fails': 'failed',
          'an ordinary passing test': 'passed',
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
