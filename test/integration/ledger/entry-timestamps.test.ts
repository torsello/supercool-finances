import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyLedgerWriter } from '../../../src/modules/ledger/adapters/persistence/kysely-ledger.js';
import { LedgerTransaction } from '../../../src/modules/ledger/index.js';
import { KyselyAuditLog } from '../../../src/platform/audit/kysely-audit-log.js';
import { TransactionRunner } from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner } from '../../../src/platform/db/unit-of-work.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import { buildProductionApp, type BuiltApp } from '../../support/app.js';
import {
  balanceOf,
  closePools,
  runtimePool,
  settlementAccountId,
  TEST_OPERATOR_ID,
} from '../../support/db.js';
import { bearer, createAccount, deposit, type MovementJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

/** The stored `created_at` of a transaction's entry on an account, at microsecond precision. */
async function entryCreatedAt(transactionId: string, accountId: string): Promise<string> {
  const result = await runtimePool().query<{ created_at: string }>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
     FROM ledger_entries WHERE transaction_id = $1 AND account_id = $2`,
    [transactionId, accountId],
  );
  const createdAt = result.rows[0]?.created_at;
  if (createdAt === undefined) throw new Error(`No entry of ${transactionId} on ${accountId}`);
  return createdAt;
}

describe('entry timestamps', () => {
  let built: BuiltApp;
  const ids = new UuidV7Generator();
  const unitOfWork = new UnitOfWorkRunner(new TransactionRunner({ pool: runtimePool() }));

  beforeAll(async () => {
    built = buildProductionApp();
    await built.app.ready();
  });

  afterAll(async () => {
    await built.app.close();
    await closePools();
  });

  it('LED-AC13 an entry written by a transaction that started before D1 but locked after it is timed after D1 and listed first', async () => {
    const c1 = tokenFor(randomUUID(), 'customer');
    const o1 = tokenFor(randomUUID(), 'operator');
    const a1 = await createAccount(built.app, c1, 'EUR');
    const account = { id: a1.id, kind: 'customer' as const, currency: 'EUR' as const };
    const s = {
      id: await settlementAccountId('EUR'),
      kind: 'system' as const,
      currency: 'EUR' as const,
    };

    // P: begins, reads its start time, lets D1 commit, then locks A1 and writes through the ledger.
    const p = await unitOfWork.run(
      async (uow) => {
        const started = await sql<{
          started: string;
        }>`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS started`.execute(
          uow.db,
        );
        const d1 = await deposit(built.app, o1, a1.id, '100');
        expect(d1.statusCode).toBe(201);

        await sql`SELECT id FROM accounts WHERE id = ${a1.id} AND kind = 'customer' FOR UPDATE`.execute(
          uow.db,
        );
        const appended = await new KyselyLedgerWriter(uow, ids).append(
          LedgerTransaction.deposit(account, s, 200n),
        );
        await new KyselyAuditLog(uow.db, ids).record({
          actorId: TEST_OPERATOR_ID,
          actorRole: 'operator',
          action: 'deposit',
          accountIds: [a1.id],
          transactionId: appended.transactionId,
          requestId: 'test-entry-timestamps',
        });
        return {
          started: started.rows[0]?.started ?? '',
          transactionId: appended.transactionId,
          d1: d1.json<MovementJson>().id,
        };
      },
      { retry: 'none' },
    );

    const d1Created = await entryCreatedAt(p.d1, a1.id);
    const pCreated = await entryCreatedAt(p.transactionId, a1.id);
    expect(p.started < d1Created).toBe(true);
    expect(pCreated > d1Created).toBe(true);
    expect(await balanceOf(a1.id)).toBe('300');

    const history = await built.app.inject({
      method: 'GET',
      url: `/v1/accounts/${a1.id}/entries`,
      headers: bearer(c1),
    });
    expect(history.statusCode).toBe(200);
    const items = history.json<{ items: { transactionId: string }[] }>().items;
    expect(items.map((item) => item.transactionId)).toEqual([p.transactionId, p.d1]);
  });
});
