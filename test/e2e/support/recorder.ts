import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { expect } from 'vitest';
import { REPOSITORY_ROOT } from '../../support/deployment.js';
import { RESPONSES_PATH } from './paths.js';

// The response recorder of plan 007 section 6: every response the e2e HTTP helpers receive is
// appended to `reports/e2e-responses.jsonl` as one JSON line, tagged with the test file that sent
// the request, so SEC-AC05 can check the whole run for 429s. The global setup empties the file
// when a run starts.

/** One line of the record: `count` responses of `status`, received by `file`. */
export interface RecordedResponses {
  file: string;
  status: number;
  count: number;
}

/** The running test file, relative to the repository root, such as `test/e2e/edge.test.ts`. */
export function currentTestFile(): string {
  const path = expect.getState().testPath;
  return path === undefined ? 'unknown' : relative(REPOSITORY_ROOT, path);
}

/** Appends `count` responses of `status` received by the running test file. */
export function recordResponses(status: number, count = 1, path = RESPONSES_PATH): void {
  const line: RecordedResponses = { file: currentTestFile(), status, count };
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`);
}

/** Every line of the record. */
export function readRecord(path = RESPONSES_PATH): RecordedResponses[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as RecordedResponses);
}
