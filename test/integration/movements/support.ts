import type pg from 'pg';
import { KyselyLedgerWriter } from '../../../src/modules/ledger/adapters/persistence/kysely-ledger.js';
import { KyselyMovementTransactions } from '../../../src/modules/movements/adapters/persistence/kysely-movements.js';
import { TransactionRunner, type RunnerPool } from '../../../src/platform/db/transaction-runner.js';
import { UnitOfWorkRunner } from '../../../src/platform/db/unit-of-work.js';
import { UuidV7Generator } from '../../../src/platform/ids/uuid-v7.js';
import { runtimePool } from '../../support/db.js';

export const C1 = '0192f0c4-0000-7000-8000-0000000000c1';
export const C2 = '0192f0c4-0000-7000-8000-0000000000c2';
export const C3 = '0192f0c4-0000-7000-8000-0000000000c3';
export const OPERATOR = { id: '0192f0c4-0000-7000-8000-0000000000ee', role: 'operator' } as const;
export const MAX = 9223372036854775807n;

export const settings = { accountLockTimeoutMs: 2000 };

/** Movements in one transaction of the unit-of-work runner, as the composition root wires them. */
export function movementTransactions(
  pool: RunnerPool<pg.PoolClient> = runtimePool(),
): KyselyMovementTransactions {
  const ids = new UuidV7Generator();
  return new KyselyMovementTransactions(new UnitOfWorkRunner(new TransactionRunner({ pool })), {
    ids,
    ledger: (uow) => new KyselyLedgerWriter(uow, ids),
  });
}

/** A customer, acting on their own accounts. */
export function customer(id: string) {
  return { id, role: 'customer' } as const;
}

/** Rows written by every movement, counted to prove that a refused one wrote nothing. */
export async function writtenRows(): Promise<{
  transactions: string;
  entries: string;
  audits: string;
}> {
  const result = await runtimePool().query<{
    transactions: string;
    entries: string;
    audits: string;
  }>(
    `SELECT (SELECT count(*) FROM transactions)::text AS transactions,
            (SELECT count(*) FROM ledger_entries)::text AS entries,
            (SELECT count(*) FROM audit_records)::text AS audits`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('count returned no row');
  return row;
}

/** The entries of a transaction, in insertion order, as [account, amount]. */
export async function entriesOf(transactionId: string): Promise<[string, string][]> {
  const result = await runtimePool().query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM ledger_entries WHERE transaction_id = $1 ORDER BY id',
    [transactionId],
  );
  return result.rows.map((row) => [row.account_id, row.amount]);
}

export interface StoredAudit {
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  request_id: string;
}

export async function auditsOf(transactionId: string): Promise<StoredAudit[]> {
  const result = await runtimePool().query<StoredAudit>(
    `SELECT actor_id, actor_role, action, account_ids::text[] AS account_ids, request_id
     FROM audit_records WHERE transaction_id = $1`,
    [transactionId],
  );
  return result.rows;
}

/** The sum of a settlement account's entries, as a bigint, to assert it only as a change. */
export async function settlementSum(settlementId: string): Promise<bigint> {
  const result = await runtimePool().query<{ sum: string }>(
    'SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger_entries WHERE account_id = $1',
    [settlementId],
  );
  return BigInt(result.rows[0]?.sum ?? 'NaN');
}

export async function setStatus(accountId: string, status: 'frozen' | 'closed'): Promise<void> {
  await runtimePool().query('UPDATE accounts SET status = $2 WHERE id = $1', [accountId, status]);
}
