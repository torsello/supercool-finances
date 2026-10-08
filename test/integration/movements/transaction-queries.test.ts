import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotFound } from '../../../src/modules/accounts/index.js';
import { KyselyTransactionQueries } from '../../../src/modules/movements/adapters/persistence/kysely-movements.js';
import { deposit, getTransaction, transfer } from '../../../src/modules/movements/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import {
  closePools,
  createCustomerAccount,
  runtimePool,
  settlementAccountId,
} from '../../support/db.js';
import { C1, C2, C3, customer, movementTransactions, OPERATOR, settings } from './support.js';

describe('transaction queries', () => {
  const queries = new KyselyTransactionQueries(createDatabase(runtimePool()));
  let a1: string;
  let b1: string;
  let s: string;
  let d: string;
  let t: string;

  beforeAll(async () => {
    const movements = movementTransactions();
    a1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C1 })).id;
    b1 = (await createCustomerAccount({ currency: 'EUR', ownerId: C2 })).id;
    s = await settlementAccountId('EUR');
    const deposited = await movements.run(
      async (tx) =>
        await deposit(tx, settings, {
          accountId: a1,
          amount: 1000n,
          currency: 'EUR',
          actor: OPERATOR,
          requestId: 'req-d',
        }),
    );
    d = deposited.transactionId;
    const transferred = await movements.run(
      async (tx) =>
        await transfer(tx, settings, {
          accountId: a1,
          destinationAccountId: b1,
          amount: 300n,
          currency: 'EUR',
          actor: customer(C1),
          requestId: 'req-t',
        }),
    );
    t = transferred.transactionId;
  });

  afterAll(async () => {
    await closePools();
  });

  it('MOV-R26 an operator gets every entry of a transaction, settlement account included', async () => {
    const operator = { userId: OPERATOR.id, role: 'operator' } as const;
    const transferRead = await getTransaction(queries, operator, t);
    expect(transferRead).toEqual({
      id: t,
      kind: 'transfer',
      amount: 300n,
      currency: 'EUR',
      createdAt: expect.stringMatching(/\.\d{6}Z$/) as string,
      entries: [
        { accountId: a1, amount: -300n },
        { accountId: b1, amount: 300n },
      ],
    });
    expect(transferRead).not.toHaveProperty('reversedTransactionId');
    await expect(getTransaction(queries, operator, d.toUpperCase())).resolves.toMatchObject({
      kind: 'deposit',
      amount: 1000n,
      entries: [
        { accountId: a1, amount: 1000n },
        { accountId: s, amount: -1000n },
      ],
    });
  });

  it('MOV-R27 a customer gets only the entries of their own accounts', async () => {
    await expect(
      getTransaction(queries, { userId: C1, role: 'customer' }, t),
    ).resolves.toMatchObject({ amount: 300n, entries: [{ accountId: a1, amount: -300n }] });
    const receiver = await getTransaction(queries, { userId: C2, role: 'customer' }, t);
    expect(receiver.entries).toEqual([{ accountId: b1, amount: 300n }]);
    expect(
      JSON.stringify(receiver, (_, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain(a1);
  });

  it('MOV-R28 a transaction with none of the customer accounts, an unknown id and an id that is not a UUID are not found', async () => {
    const cases: [string, string][] = [
      [C2, d],
      [C3, t],
      [C1, randomUUID()],
      [C1, 'not-a-uuid'],
    ];
    for (const [userId, id] of cases) {
      await expect(
        getTransaction(queries, { userId, role: 'customer' }, id),
      ).rejects.toBeInstanceOf(NotFound);
    }
    await expect(
      getTransaction(queries, { userId: OPERATOR.id, role: 'operator' }, randomUUID()),
    ).rejects.toBeInstanceOf(NotFound);
  });
});
