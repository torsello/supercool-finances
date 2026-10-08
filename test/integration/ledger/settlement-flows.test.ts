import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool, settlementAccountId } from '../../support/db.js';
import {
  createAccount,
  deposit,
  transfer,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { accountRow, entriesSum } from './api-support.js';

/** A transaction's kind and its entries in insertion order, as [account, amount]. */
async function storedTransaction(
  id: string,
): Promise<{ kind: string | undefined; entries: [string, string][] }> {
  const kind = await runtimePool().query<{ kind: string }>(
    'SELECT kind FROM transactions WHERE id = $1',
    [id],
  );
  const entries = await runtimePool().query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY id',
    [id],
  );
  return {
    kind: kind.rows[0]?.kind,
    entries: entries.rows.map((row) => [row.account_id, row.amount]),
  };
}

describe('settlement flows', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC07 deposits and withdrawals settle through S, a transfer does not, and S moves by the net amount without a cached balance', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const c2 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const b1 = await createAccount(built.app, c2, 'EUR');
    const s = await settlementAccountId('EUR');
    const sBefore = BigInt(await entriesSum(s));

    const deposited = await deposit(built.app, o1, a1.id, '5000');
    const withdrawn = await withdraw(built.app, c1, a1.id, '1200');
    const transferred = await transfer(built.app, c1, a1.id, b1.id, '300');
    for (const response of [deposited, withdrawn, transferred]) {
      expect(response.statusCode, response.body).toBe(201);
    }

    expect(await storedTransaction(deposited.json<MovementJson>().id)).toEqual({
      kind: 'deposit',
      entries: [
        [a1.id, '5000'],
        [s, '-5000'],
      ],
    });
    expect(await storedTransaction(withdrawn.json<MovementJson>().id)).toEqual({
      kind: 'withdrawal',
      entries: [
        [a1.id, '-1200'],
        [s, '1200'],
      ],
    });
    expect(await storedTransaction(transferred.json<MovementJson>().id)).toEqual({
      kind: 'transfer',
      entries: [
        [a1.id, '-300'],
        [b1.id, '300'],
      ],
    });

    expect(await balanceOf(a1.id)).toBe('3500');
    expect(await entriesSum(a1.id)).toBe('3500');
    expect(await balanceOf(b1.id)).toBe('300');
    expect(await entriesSum(b1.id)).toBe('300');

    expect(BigInt(await entriesSum(s)) - sBefore).toBe(-3800n);
    expect((await accountRow(s)).balance).toBeNull();
  });
});
