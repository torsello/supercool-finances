import { describe, expect, it } from 'vitest';
import { withDefaults, readCompose } from '../support/deployment.js';
import { readRecord } from './support/recorder.js';
import { containerOf } from './support/stack.js';

/** The files whose requests exceed a limit on purpose, each with a user of its own (SEC-R09). */
const OVER_THE_LIMIT_ON_PURPOSE = ['test/e2e/user-rate-limit.test.ts'];

/** A variable of a container's environment, as Docker reports it. */
async function environmentOf(service: string, name: string): Promise<string | undefined> {
  const container = await containerOf(service);
  return (container.Config.Env ?? [])
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe('the limits during the e2e and load suites', () => {
  it('SEC-AC05 no response of the e2e suite or the load test is a 429, except where a test exceeds a limit on purpose', async () => {
    // Given: every limit unset, so the stack runs with the defaults of compose.yaml.
    const compose = readCompose();
    for (const [service, names] of [
      ['nginx', ['RATE_LIMIT_IP_RPS', 'RATE_LIMIT_IP_BURST']],
      ['api-1', ['RATE_LIMIT_USER_MAX', 'RATE_LIMIT_USER_WINDOW_S']],
      ['api-2', ['RATE_LIMIT_USER_MAX', 'RATE_LIMIT_USER_WINDOW_S']],
    ] as const) {
      for (const name of names) {
        const written = compose.service(service).rawEnvironment[name] ?? '';
        expect(await environmentOf(service, name), `${service} ${name}`).toBe(
          withDefaults(written),
        );
      }
    }

    const record = readRecord();
    const total = (file: string): number =>
      record.filter((line) => line.file === file).reduce((sum, line) => sum + line.count, 0);
    // The record covers this run's files, the load test of SYS-AC17 among them.
    expect(total('test/e2e/load.test.ts')).toBeGreaterThan(10_000);
    expect(new Set(record.map((line) => line.file)).size).toBeGreaterThan(10);

    const limited = record.filter(
      (line) => line.status === 429 && !OVER_THE_LIMIT_ON_PURPOSE.includes(line.file),
    );
    expect(limited).toEqual([]);
  });
});
