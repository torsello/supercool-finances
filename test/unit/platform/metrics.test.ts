import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/platform/config/config.js';
import { TEST_CURSOR_SECRET } from '../../support/app.js';
import { parseMetrics, type Sample } from '../../support/metrics.js';
import { K } from '../../support/tokens.js';

const KINDS = ['deposit', 'withdrawal', 'transfer', 'reversal'] as const;

/** The samples of `name`, each as its labels and value. */
function seriesOf(samples: readonly Sample[], name: string) {
  return samples
    .filter((sample) => sample.name === name)
    .map(({ labels, value }) => ({ labels, value }));
}

/** `labels` at `value`, for each set of labels. */
function at(value: number, labels: Record<string, string>[]) {
  return labels.map((set) => ({ labels: set, value }));
}

describe('the metrics', () => {
  // The pool and Redis connect lazily, so this app never reaches either.
  const app = buildApp(
    loadConfig({
      DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      JWT_SECRET: K,
      JWT_ISSUER: 'scf-test',
      JWT_AUDIENCE: 'scf-api',
      CURSOR_SECRET: TEST_CURSOR_SECRET,
      LOG_LEVEL: 'fatal',
    }),
  );

  afterAll(async () => {
    await app.close();
  });

  it('SEC-AC47 exposes every counter of table 1.4 at 0 from startup, for every label value', async () => {
    const read = async () => parseMetrics((await app.metrics.exposition()).body);
    const sorted = (series: { labels: Record<string, string>; value: number }[]) =>
      [...series].sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)));

    const first = await read();

    expect(sorted(seriesOf(first, 'scf_money_movements_total'))).toEqual(
      sorted(
        at(
          0,
          KINDS.flatMap((kind) =>
            ['applied', 'rejected', 'failed'].map((outcome) => ({ kind, outcome })),
          ),
        ),
      ),
    );
    expect(sorted(seriesOf(first, 'scf_idempotent_replays_total'))).toEqual(
      sorted(
        at(
          0,
          [...KINDS, 'account_creation'].map((kind) => ({ kind })),
        ),
      ),
    );
    expect(sorted(seriesOf(first, 'scf_lock_timeouts_total'))).toEqual(
      sorted(at(0, [{ lock: 'account' }, { lock: 'idempotency' }])),
    );
    expect(sorted(seriesOf(first, 'scf_transaction_retries_total'))).toEqual(
      sorted(at(0, [{ sqlstate: '40P01' }, { sqlstate: '40001' }])),
    );
    for (const name of [
      'scf_transaction_retries_exhausted_total',
      'scf_db_pool_acquire_timeouts_total',
      'scf_rate_limited_total',
      'scf_rate_limit_store_errors_total',
    ]) {
      expect(seriesOf(first, name), name).toEqual([{ labels: {}, value: 0 }]);
    }

    app.metrics.lockTimeout('account');
    const second = await read();

    expect(sorted(seriesOf(second, 'scf_lock_timeouts_total'))).toEqual(
      sorted([
        { labels: { lock: 'account' }, value: 1 },
        { labels: { lock: 'idempotency' }, value: 0 },
      ]),
    );
  });
});
