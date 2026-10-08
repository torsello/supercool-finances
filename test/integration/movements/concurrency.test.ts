import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyReconciliation } from '../../../src/modules/ledger/adapters/persistence/kysely-reconciliation.js';
import { reconcile } from '../../../src/modules/ledger/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import { balanceOf, closePools, runtimePool } from '../../support/db.js';
import {
  createAccount,
  deposit,
  problemOf,
  withdraw,
  type MovementJson,
} from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';
import { transactionsOfKind } from './support.js';

describe('concurrent movements', () => {
  let built: BuiltApp;

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('MOV-AC13 100 concurrent withdrawals of "300" from "10000" accept exactly 33, refuse 67 for funds, and never overdraw', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    expect((await deposit(built.app, o1, a1.id, '10000')).statusCode).toBe(201);

    const responses = await Promise.all(
      Array.from({ length: 100 }, () => withdraw(built.app, c1, a1.id, '300')),
    );

    expect(responses.filter((response) => response.statusCode >= 500)).toEqual([]);
    const accepted = responses.filter((response) => response.statusCode === 201);
    const refused = responses.filter((response) => response.statusCode === 422);
    expect(accepted).toHaveLength(33);
    expect(refused).toHaveLength(67);
    for (const response of refused) {
      expect(problemOf(response).type).toBe('/problems/insufficient-funds');
    }
    const sum = accepted
      .map((response) => BigInt(response.json<MovementJson>().amount))
      .reduce((total, amount) => total + amount, 0n);
    expect(sum).toBe(9900n);
    expect(await balanceOf(a1.id)).toBe('100');
    expect(await transactionsOfKind(a1.id, 'withdrawal')).toHaveLength(33);

    const result = await reconcile(new KyselyReconciliation(createDatabase(runtimePool())));
    expect(result.report.discrepancies).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});
