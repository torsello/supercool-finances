import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyReconciliation } from '../../../src/modules/ledger/adapters/persistence/kysely-reconciliation.js';
import { CURRENCIES, reconcile } from '../../../src/modules/ledger/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import {
  closePools,
  createCustomerAccount,
  rollingBack,
  runtimePool,
  writeDirectDeposit,
} from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

const CLEAN_TOTALS = CURRENCIES.map(({ code: currency }) => ({
  currency,
  sum: '0',
}));

describe('reconciliation', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
    await closePools();
  });

  it('LED-AC14 reports a drifted cached balance and the global sums inside the transaction that drifted, and nothing after its rollback', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR' });
    await writeDirectDeposit(a1, '1000');
    const b1 = await createCustomerAccount({ currency: 'EUR' });
    await writeDirectDeposit(b1, '500');

    const drifted = await rollingBack(client, async () => {
      await client.query('UPDATE accounts SET balance = 700 WHERE id = $1', [b1.id]);
      return await reconcile(new KyselyReconciliation(new UnitOfWork(client).db));
    });

    expect(drifted.report.discrepancies).toEqual([
      {
        accountId: b1.id,
        currency: 'EUR',
        cachedBalance: '700',
        entriesSum: '500',
        difference: '200',
      },
    ]);
    expect(drifted.report.totals).toEqual([
      { currency: 'USD', sum: '0' },
      { currency: 'MXN', sum: '0' },
      { currency: 'EUR', sum: '200' },
      { currency: 'COP', sum: '0' },
      { currency: 'JPY', sum: '0' },
    ]);
    expect(drifted.exitCode).toBe(1);

    const clean = await reconcile(new KyselyReconciliation(createDatabase(runtimePool())));
    expect(clean).toEqual({ report: { discrepancies: [], totals: CLEAN_TOTALS }, exitCode: 0 });
  });

  it('LED-R19 LED-R21 exits 1 for a non-zero global sum alone, without a discrepancy', async () => {
    const result = await reconcile({
      discrepancies: () => Promise.resolve([]),
      totals: () =>
        Promise.resolve(
          CLEAN_TOTALS.map((total) => (total.currency === 'JPY' ? { ...total, sum: '-1' } : total)),
        ),
    });
    expect(result.exitCode).toBe(1);
  });
});
