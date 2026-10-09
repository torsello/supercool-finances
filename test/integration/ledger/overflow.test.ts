import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyBalanceQueries } from '../../../src/modules/ledger/adapters/persistence/kysely-ledger.js';
import { KyselyReconciliation } from '../../../src/modules/ledger/adapters/persistence/kysely-reconciliation.js';
import { reconcile } from '../../../src/modules/ledger/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import { createAccount, deposit } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

const MAX = '9223372036854775807';

describe('system balances and global sums', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp({ env: { MAX_AMOUNT_MINOR: MAX } });
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC10 two deposits of the maximum amount move S by twice the maximum without overflow, and the reconciliation stays clean', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const a2 = await createAccount(built.app, c1, 'EUR');
    const s = await settlementAccountId('EUR');
    // S's balance as the service computes it: the sum of its entries (LED-R13, LED-R15).
    const balances = new KyselyBalanceQueries(createDatabase(runtimePool()));
    const before = BigInt(await balances.entriesSum(s));

    expect((await deposit(built.app, o1, a1.id, MAX)).statusCode).toBe(201);
    expect((await deposit(built.app, o1, a2.id, MAX)).statusCode).toBe(201);

    expect(before - BigInt(await balances.entriesSum(s))).toBe(18446744073709551614n);

    const result = await reconcile(new KyselyReconciliation(createDatabase(runtimePool())));
    expect(result.report.discrepancies).toEqual([]);
    expect(result.report.totals.find((total) => total.currency === 'EUR')).toEqual({
      currency: 'EUR',
      sum: '0',
    });
    expect(result.exitCode).toBe(0);
  });
});
