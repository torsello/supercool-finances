import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { NotFound } from '../../../src/modules/accounts/index.js';
import { InsufficientFunds, withdraw } from '../../../src/modules/movements/index.js';
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
  movementTransactions,
  settings,
  writtenRows,
} from './support.js';

describe('withdrawal use case', () => {
  const movements = movementTransactions();

  afterAll(async () => {
    await closePools();
  });

  function withdrawFrom(accountId: string, amount: bigint, actorId = C1) {
    return movements.run(
      async (tx) =>
        await withdraw(tx, settings, {
          accountId,
          amount,
          currency: 'EUR',
          actor: customer(actorId),
          requestId: 'req-withdraw',
        }),
    );
  }

  it('MOV-R02 MOV-R24 the owner withdraws, the whole balance included, with −A on the account, +A on the settlement account and one audit record', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '5000');
    const s = await settlementAccountId('EUR');

    const first = await withdrawFrom(a1.id, 1200n);
    expect(first).toEqual({
      transactionId: expect.any(String) as string,
      kind: 'withdrawal',
      amount: 1200n,
      currency: 'EUR',
      createdAt: expect.stringMatching(/\.\d{6}Z$/) as string,
      accountId: a1.id,
      balance: 3800n,
    });
    expect(await entriesOf(first.transactionId)).toEqual([
      [a1.id, '-1200'],
      [s, '1200'],
    ]);
    expect(await auditsOf(first.transactionId)).toEqual([
      {
        actor_id: C1,
        actor_role: 'customer',
        action: 'withdrawal',
        account_ids: [a1.id],
        request_id: 'req-withdraw',
      },
    ]);

    const whole = await withdrawFrom(a1.id, 3800n);
    expect(whole).toMatchObject({ accountId: a1.id, balance: 0n });
    expect(await balanceOf(a1.id)).toBe('0');
  });

  it('MOV-R05 another customer account, a system account and an unknown id are not found, and nothing is written', async () => {
    const b1 = await createCustomerAccount({ currency: 'EUR', ownerId: C2 });
    await writeDirectDeposit(b1, '1000');
    const s = await settlementAccountId('EUR');
    const before = await writtenRows();
    for (const id of [b1.id, s, randomUUID(), 'not-a-uuid']) {
      await expect(withdrawFrom(id, 100n)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(b1.id)).toBe('1000');
  });

  it('MOV-R16 a withdrawal above the balance is refused, with nothing written', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    await writeDirectDeposit(a1, '1000');
    const before = await writtenRows();
    await expect(withdrawFrom(a1.id, 1001n)).rejects.toBeInstanceOf(InsufficientFunds);
    expect(await writtenRows()).toEqual(before);
    expect(await balanceOf(a1.id)).toBe('1000');
  });
});
