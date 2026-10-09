import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyReconciliation } from '../../../src/modules/ledger/adapters/persistence/kysely-reconciliation.js';
import { reconcile } from '../../../src/modules/ledger/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';
import { transfer } from '../../support/http.js';
import { openLockSession } from '../../support/sessions.js';
import { tokenFor } from '../../support/tokens.js';

describe('reconciliation while money moves', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp({
      env: {
        DB_POOL_ACQUIRE_TIMEOUT_MS: '10000',
        REQUEST_TIMEOUT_MS: '30000',
        SHUTDOWN_TIMEOUT_MS: '30000',
      },
    });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC15 the reconciliation stays clean during 200 concurrent transfers, and never waits for a row lock', async () => {
    const db = createDatabase(runtimePool());
    const query = new KyselyReconciliation(db);
    const owners = Array.from({ length: 10 }, () => randomUUID());
    const accounts = await Promise.all(
      owners.map(async (ownerId) => await createCustomerAccount({ currency: 'EUR', ownerId })),
    );
    for (const account of accounts) await writeDirectDeposit(account, '10000');

    let settled = 0;
    const transfers = Promise.all(
      Array.from({ length: 200 }, async (_, i) => {
        const from = i % 10;
        const to = (i + 1) % 10;
        const source = accounts[from];
        const destination = accounts[to];
        const owner = owners[from];
        if (source === undefined || destination === undefined || owner === undefined) {
          throw new Error('no account');
        }
        const response = await transfer(
          built.app,
          tokenFor(owner, 'customer'),
          source.id,
          destination.id,
          '10',
        );
        settled += 1;
        return response;
      }),
    );
    // Reconciles until every transfer has settled, at least 20 times, recording how many
    // reconciliations finished while transfers were still pending.
    const reports = [];
    let duringTransfers = 0;
    while (reports.length < 20 || settled < 200) {
      reports.push(await reconcile(query));
      if (settled < 200) duringTransfers += 1;
    }
    const responses = await transfers;
    // At least one reconciliation ran while the transfers were still moving money.
    expect(duringTransfers).toBeGreaterThan(0);

    for (const [run, { report, exitCode }] of reports.entries()) {
      expect(report.discrepancies, `run ${String(run)}`).toEqual([]);
      expect(
        report.totals.every((total) => total.sum === '0'),
        `run ${String(run)}`,
      ).toBe(true);
      expect(exitCode).toBe(0);
    }
    expect(responses.filter((response) => response.statusCode >= 500)).toEqual([]);
    expect(responses.every((response) => response.statusCode === 201)).toBe(true);
    for (const account of accounts) expect(await balanceOf(account.id)).toBe('10000');

    const session = await openLockSession();
    try {
      await session.lockRow('accounts', accounts[0]?.id ?? '');
      // Completes while the session still holds the lock, which is released only afterwards.
      const last = await reconcile(query);
      expect(last.report.discrepancies).toEqual([]);
      expect(last.exitCode).toBe(0);
      await session.release();
    } finally {
      await session.close();
    }
  });
});
