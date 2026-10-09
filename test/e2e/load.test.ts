import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_RATE_PER_SECOND,
  loadParameters,
  REPORT_PATH,
  RESULT_PATH,
  type LoadResult,
} from '../../scripts/load-test.js';
import { REPOSITORY_ROOT } from '../support/deployment.js';
import { describeResult, run } from './support/command.js';
import { closeStackDb, ledgerState } from './support/db.js';
import { recordResponses } from './support/recorder.js';
import {
  containerLogs,
  daemonTime,
  ensureStack,
  jsonLines,
  waitForBothReplicasThroughNginx,
} from './support/stack.js';

/**
 * Why the replicas answered 5xx since `since`: the `cause` of each `service unavailable` line
 * and the message of each `error` line, counted by replica, for the message of a failed run.
 */
async function serverErrorCauses(since: string): Promise<Record<string, Record<string, number>>> {
  const causes: Record<string, Record<string, number>> = {};
  for (const replica of ['api-1', 'api-2']) {
    const counts: Record<string, number> = {};
    for (const line of jsonLines(await containerLogs(replica, since))) {
      const cause =
        line['msg'] === 'service unavailable'
          ? `service unavailable: ${String(line['cause'])}`
          : line['level'] === 50
            ? `error: ${String(line['msg'])}`
            : undefined;
      if (cause !== undefined) counts[cause] = (counts[cause] ?? 0) + 1;
    }
    causes[replica] = counts;
  }
  return causes;
}

describe('the load test', () => {
  beforeAll(async () => {
    await ensureStack();
    await waitForBothReplicasThroughNginx();
  });

  afterAll(closeStackDb);

  it('SYS-AC17 measures and reports latency at LOAD_RATE_PER_SECOND movements per second (200 by default) for 60 s, with no 5xx and a reconciled ledger', async () => {
    // The CI job e2e sets LOAD_RATE_PER_SECOND to 100; locally it is unset, so the run is at 200.
    const parameters = loadParameters();
    const since = await daemonTime();
    const started = Date.now();
    const result = await run('npm', ['run', '--silent', 'load'], {
      cwd: REPOSITORY_ROOT,
      timeoutMs: 600_000,
    });
    const report = JSON.parse(readFileSync(RESULT_PATH, 'utf8')) as LoadResult;
    expect(Date.parse(report.finishedAt)).toBeGreaterThan(started);

    // Every response of the load test joins the record that SEC-AC05 reads.
    for (const [status, count] of Object.entries(report.setup.statusCodes)) {
      recordResponses(Number(status), count);
    }
    for (const [status, count] of Object.entries(report.run.statusCodes)) {
      recordResponses(Number(status), count);
    }

    expect(report.parameters).toEqual(parameters);
    expect(report.parameters).toMatchObject({
      ratePerSecond: Number(process.env['LOAD_RATE_PER_SECOND'] || DEFAULT_RATE_PER_SECOND),
      durationSeconds: 60,
      pairs: 1000,
    });
    // An open model: all rate × 60 requests of the schedule were sent on time, in equal thirds, and
    // each one ended with an answer; none was lost or failed to connect. The achieved throughput
    // and the latencies are reported, whatever they are.
    const scheduled = parameters.ratePerSecond * parameters.durationSeconds;
    expect(report.run.scheduled).toBe(scheduled);
    expect(report.run.sent).toBe(scheduled);
    expect(report.run.generator.behind, JSON.stringify(report.run.generator)).toBe(false);
    expect(report.run.responses).toBe(scheduled);
    expect(report.run.byKind).toEqual({
      deposit: scheduled / 3,
      withdrawal: scheduled / 3,
      transfer: scheduled / 3,
    });
    expect(report.run.lost).toBe(0);
    expect(report.run.errors, JSON.stringify(report.run.errorCodes)).toBe(0);

    // The report: the machine, p50, p95 and p99, throughput and the non-2xx count.
    const markdown = readFileSync(REPORT_PATH, 'utf8');
    for (const value of [
      report.machine.host,
      report.machine.docker,
      `${String(report.run.latencyMs.p50)} ms`,
      `${String(report.run.latencyMs.p95)} ms`,
      `${String(report.run.latencyMs.p99)} ms`,
      `${String(report.run.throughputPerSecond)} responses per second`,
      `Non-2xx responses`,
      'Lost requests',
    ]) {
      expect(markdown).toContain(value);
    }
    // A p99 at or above 300 ms is a missed target, reported, never a failure.
    expect(markdown).toContain(report.run.p99TargetMet ? 'met: p99' : 'missed: p99');

    if (report.run.fiveXx > 0) {
      const detail = {
        statusCodes: report.run.statusCodes,
        fiveXxTypes: report.run.fiveXxTypes,
        causes: await serverErrorCauses(since),
      };
      expect(report.run.fiveXx, JSON.stringify(detail)).toBe(0);
    }
    expect(report.run.fiveXx).toBe(0);

    // SYS-AC11 and SYS-AC12 hold after the run.
    expect(report.reconciliation.exitCode).toBe(0);
    const state = await ledgerState();
    for (const sum of state.sums) expect(sum.sum, sum.currency).toBe('0');
    expect(state.drifted).toEqual([]);
    expect(state.systemWithBalance).toBe(0);

    expect(report.passed).toBe(true);
    expect(result.code, describeResult('npm', ['run', 'load'], result)).toBe(0);
  });
});
