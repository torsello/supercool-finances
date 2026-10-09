import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRepositoryFile } from '../support/deployment.js';
import { describeResult, run } from './support/command.js';
import { ensureStack, runToolsOk } from './support/stack.js';
import { BASE_URL } from './support/urls.js';

/** newman, pinned to an exact version and run through npx (section 1.11 of spec 008). */
const NEWMAN = 'newman@6.2.3';

const COLLECTION = 'docs/api/postman/supercool-finances.postman_collection.json';
const ENVIRONMENT = 'docs/api/postman/local.postman_environment.json';

interface PostmanItem {
  item?: PostmanItem[];
}

/** The number of requests of the collection, folders flattened. */
function requestCount(items: readonly PostmanItem[]): number {
  return items.reduce(
    (count, item) => count + (item.item === undefined ? 1 : requestCount(item.item)),
    0,
  );
}

interface NewmanReport {
  run: {
    stats: {
      requests: { total: number; failed: number };
      assertions: { total: number; failed: number };
      testScripts: { failed: number };
      prerequestScripts: { failed: number };
    };
    failures: unknown[];
  };
}

// After load.test.ts by name, in the second group of the sequencer, and one file at a time: never
// during the load test of SYS-AC17.
describe('the Postman collection against the stack', () => {
  let directory: string;

  beforeAll(async () => {
    await ensureStack();
    // The seed is idempotent: it leaves an already seeded stack as it is.
    await runToolsOk(['npm', 'run', '--silent', 'seed']);
    directory = mkdtempSync(join(tmpdir(), 'scf-newman-'));
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('DEP-AC38 newman runs every request of the collection and every assertion passes', async () => {
    const report = join(directory, 'newman.json');
    const args = [
      '--yes',
      NEWMAN,
      'run',
      COLLECTION,
      '--environment',
      ENVIRONMENT,
      '--env-var',
      `baseUrl=${BASE_URL}`,
      '--reporters',
      'cli,json',
      '--reporter-json-export',
      report,
      '--color',
      'off',
    ];
    const result = await run('npx', args, { timeoutMs: 300_000 });
    expect(result.code, describeResult('npx', args, result)).toBe(0);

    const { stats, failures } = (JSON.parse(readFileSync(report, 'utf8')) as NewmanReport).run;
    const collection = JSON.parse(readRepositoryFile(COLLECTION)) as { item: PostmanItem[] };
    expect(stats.requests).toMatchObject({ total: requestCount(collection.item), failed: 0 });
    expect(stats.assertions.total).toBeGreaterThan(0);
    expect(stats.assertions.failed).toBe(0);
    expect(stats.testScripts.failed).toBe(0);
    expect(stats.prerequestScripts.failed).toBe(0);
    expect(failures).toEqual([]);
  });
});
