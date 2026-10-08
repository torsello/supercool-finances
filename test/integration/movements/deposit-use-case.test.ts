import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AccountNotActive, NotFound } from '../../../src/modules/accounts/index.js';
import type { CurrencyCode } from '../../../src/modules/ledger/index.js';
import { CurrencyMismatch, deposit } from '../../../src/modules/movements/index.js';
import {
  balanceOf,
  closePools,
  createCustomerAccount,
  settlementAccountId,
} from '../../support/db.js';
import {
  auditsOf,
  C1,
  entriesOf,
  movementTransactions,
  OPERATOR,
  setStatus,
  settings,
  settlementSum,
  writtenRows,
} from './support.js';

describe('deposit use case', () => {
  const movements = movementTransactions();

  afterAll(async () => {
    await closePools();
  });

  function depositInto(accountId: string, amount: bigint, currency: CurrencyCode = 'EUR') {
    return movements.run(
      async (tx) =>
        await deposit(tx, settings, {
          accountId,
          amount,
          currency,
          actor: OPERATOR,
          requestId: 'req-deposit',
        }),
    );
  }

  it('MOV-R01 MOV-R24 an operator deposit appends +A on the account and −A on the settlement account, raises the balance and writes one audit record', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR', ownerId: C1 });
    const s = await settlementAccountId('EUR');
    const before = await settlementSum(s);

    const result = await depositInto(a1.id.toUpperCase(), 5000n);

    expect(result).toEqual({
      transactionId: expect.any(String) as string,
      kind: 'deposit',
      amount: 5000n,
      currency: 'EUR',
      createdAt: expect.stringMatching(/\.\d{6}Z$/) as string,
    });
    expect(await entriesOf(result.transactionId)).toEqual([
      [a1.id, '5000'],
      [s, '-5000'],
    ]);
    expect(await balanceOf(a1.id)).toBe('5000');
    expect((await settlementSum(s)) - before).toBe(-5000n);
    expect(await auditsOf(result.transactionId)).toEqual([
      {
        actor_id: OPERATOR.id,
        actor_role: 'operator',
        action: 'deposit',
        account_ids: [a1.id],
        request_id: 'req-deposit',
      },
    ]);
  });

  it('MOV-R05 an unknown account, a system account and an id that is not a UUID are not found, and nothing is written', async () => {
    const s = await settlementAccountId('EUR');
    const before = await writtenRows();
    for (const id of [randomUUID(), s, 'not-a-uuid']) {
      await expect(depositInto(id, 100n)).rejects.toBeInstanceOf(NotFound);
    }
    expect(await writtenRows()).toEqual(before);
  });

  it('MOV-R11 MOV-R12 another currency and a frozen or closed account are refused, with nothing written', async () => {
    const a1 = await createCustomerAccount({ currency: 'EUR' });
    const f1 = await createCustomerAccount({ currency: 'EUR' });
    await setStatus(f1.id, 'frozen');
    const x1 = await createCustomerAccount({ currency: 'EUR' });
    await setStatus(x1.id, 'closed');
    const before = await writtenRows();

    await expect(depositInto(a1.id, 100n, 'USD')).rejects.toBeInstanceOf(CurrencyMismatch);
    await expect(depositInto(f1.id, 100n)).rejects.toBeInstanceOf(AccountNotActive);
    await expect(depositInto(x1.id, 100n)).rejects.toBeInstanceOf(AccountNotActive);

    expect(await writtenRows()).toEqual(before);
    for (const id of [a1.id, f1.id, x1.id]) expect(await balanceOf(id)).toBe('0');
  });
});
