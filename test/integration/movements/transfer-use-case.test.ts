import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AccountNotActive, NotFound } from '../../../src/modules/accounts/index.js';
import {
  CurrencyMismatch,
  DestinationUnavailable,
  transfer,
} from '../../../src/modules/movements/index.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  settlementAccountId,
  writeDirectDeposit,
} from '../../support/db.js';
import {
  auditsOf,
  C1,
  C2,
  customer,
  entriesOf,
  MAX,
  movementTransactions,
  setStatus,
  settings,
  writtenRows,
} from './support.js';

describe('transfer use case', () => {
  const movements = movementTransactions();

  afterAll(async () => {
    await closePools();
  });

  function transferFrom(source: string, destination: string, amount: bigint, actorId = C1) {
    return movements.run(
      async (tx) =>
        await transfer(tx, settings, {
          accountId: source,
          destinationAccountId: destination,
          amount,
          currency: 'EUR',
          actor: customer(actorId),
          requestId: 'req-transfer',
        }),
    );
  }

  async function account(ownerId: string, balance?: string, currency: 'EUR' | 'USD' = 'EUR') {
    const created = await createCustomerAccount({ currency, ownerId });
    if (balance !== undefined) await writeDirectDeposit(created, balance);
    return created.id;
  }

  it('MOV-R03 MOV-R24 transfers to another customer and to an own account, with one audit record of both accounts', async () => {
    const a1 = await account(C1, '5000');
    const a2 = await account(C1);
    const b1 = await account(C2, '100');

    const toOther = await transferFrom(a1, b1, 300n);
    expect(toOther).toEqual({
      transactionId: expect.any(String) as string,
      kind: 'transfer',
      amount: 300n,
      currency: 'EUR',
      createdAt: expect.stringMatching(/\.\d{6}Z$/) as string,
      accountId: a1,
      balance: 4700n,
    });
    expect(await entriesOf(toOther.transactionId)).toEqual([
      [a1, '-300'],
      [b1, '300'],
    ]);
    expect(await auditsOf(toOther.transactionId)).toEqual([
      {
        actor_id: C1,
        actor_role: 'customer',
        action: 'transfer',
        account_ids: [a1, b1].toSorted(),
        request_id: 'req-transfer',
      },
    ]);

    const toOwn = await transferFrom(a1, a2.toUpperCase(), 700n);
    expect(toOwn).toMatchObject({ accountId: a1, balance: 4000n });
    expect([await balanceOf(a1), await balanceOf(a2), await balanceOf(b1)]).toEqual([
      '4000',
      '700',
      '400',
    ]);
  });

  it('MOV-R13 MOV-R14 an own frozen destination and an own destination in another currency are refused, with nothing written', async () => {
    const a1 = await account(C1, '1000');
    const frozen = await account(C1, '10');
    await setStatus(frozen, 'frozen');
    const dollars = await account(C1, '10', 'USD');
    const before = await writtenRows();

    await expect(transferFrom(a1, frozen, 100n)).rejects.toBeInstanceOf(AccountNotActive);
    await expect(transferFrom(a1, dollars, 100n)).rejects.toBeInstanceOf(CurrencyMismatch);

    expect(await writtenRows()).toEqual(before);
    expect([await balanceOf(a1), await balanceOf(frozen), await balanceOf(dollars)]).toEqual([
      '1000',
      '10',
      '10',
    ]);
  });

  it('MOV-R15 every unavailable destination gives DestinationUnavailable, with nothing written and its balance unchanged', async () => {
    const a1 = await account(C1, '10000');
    const s = await settlementAccountId('EUR');
    const otherFrozen = await account(C2, '7');
    await setStatus(otherFrozen, 'frozen');
    const otherClosed = await account(C2);
    await setStatus(otherClosed, 'closed');
    const otherDollars = await account(C2, '7', 'USD');
    const otherFull = await account(C2, MAX.toString());
    const ownFull = await account(C1, MAX.toString());
    const destinations = [
      randomUUID(),
      s,
      otherFrozen,
      otherClosed,
      otherDollars,
      otherFull,
      ownFull,
    ];
    const balances = async () =>
      await Promise.all(
        [a1, otherFrozen, otherClosed, otherDollars, otherFull, ownFull].map(balanceOf),
      );
    const before = { rows: await writtenRows(), balances: await balances() };

    for (const destination of destinations) {
      await expect(transferFrom(a1, destination, 100n)).rejects.toBeInstanceOf(
        DestinationUnavailable,
      );
    }

    expect({ rows: await writtenRows(), balances: await balances() }).toEqual(before);
  });

  it('MOV-R05 a source of another customer, a system account or an unknown id is not found', async () => {
    const b1 = await account(C2, '1000');
    const a1 = await account(C1);
    const s = await settlementAccountId('EUR');
    const before = await writtenRows();
    for (const source of [b1, s, randomUUID(), 'not-a-uuid']) {
      await expect(transferFrom(source, a1, 100n)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await writtenRows()).toEqual(before);
  });
});
