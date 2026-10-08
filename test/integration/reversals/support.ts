import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { KyselyReconciliation } from '../../../src/modules/ledger/adapters/persistence/kysely-reconciliation.js';
import { reconcile, type ReconciliationReport } from '../../../src/modules/ledger/index.js';
import { createDatabase } from '../../../src/platform/db/database.js';
import type { BuiltApp } from '../../support/app.js';
import { runtimePool } from '../../support/db.js';
import { bearer, type MovementJson, type TransactionJson } from '../../support/http.js';
import { tokenFor } from '../../support/tokens.js';

type App = BuiltApp['app'];

/** The users of the spec's preamble, fresh for each test, with their tokens. */
export function users() {
  const ids = { c1: randomUUID(), c2: randomUUID(), c3: randomUUID(), o1: randomUUID() };
  return {
    ids,
    c1: tokenFor(ids.c1, 'customer'),
    c2: tokenFor(ids.c2, 'customer'),
    c3: tokenFor(ids.c3, 'customer'),
    o1: tokenFor(ids.o1, 'operator'),
  };
}

/** The id of a movement's 201 answer, after checking the status. */
export function idOf(response: LightMyRequestResponse): string {
  expect(response.statusCode, response.body).toBe(201);
  return response.json<MovementJson>().id;
}

/** Reads a transaction through the API. */
export async function readTransaction(
  app: App,
  token: string,
  id: string,
): Promise<LightMyRequestResponse> {
  return await app.inject({ method: 'GET', url: `/v1/transactions/${id}`, headers: bearer(token) });
}

/** The entries of a transaction as an operator reads them, as [account, amount]. */
export async function entriesRead(app: App, operator: string, id: string): Promise<string[][]> {
  const response = await readTransaction(app, operator, id);
  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<TransactionJson>()
    .entries.map((entry) => [entry.accountId, entry.amount])
    .sort();
}

/** A reversal by an operator with any body, and the headers given. */
export async function reverseWith(
  app: App,
  token: string,
  transactionId: string,
  payload: unknown,
  headers: Record<string, string> = { 'idempotency-key': randomUUID() },
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: `/v1/transactions/${transactionId}/reversals`,
    headers: { ...bearer(token), ...headers },
    payload: payload as Record<string, unknown>,
  });
}

/** The ids of the reversals of a transaction. */
export async function reversalsOf(transactionId: string): Promise<string[]> {
  const result = await runtimePool().query<{ id: string }>(
    'SELECT id FROM transactions WHERE reversed_transaction_id = $1 ORDER BY id',
    [transactionId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * What the movements of a test wrote on its own accounts: transactions with an entry on one of
 * them, their entries, and audit records naming one of them. Fresh accounts make it independent of
 * other test files sharing the database.
 */
export async function footprint(
  accountIds: readonly string[],
): Promise<{ transactions: number; entries: number; audits: number }> {
  const result = await runtimePool().query<{
    transactions: number;
    entries: number;
    audits: number;
  }>(
    `SELECT (SELECT count(DISTINCT transaction_id) FROM ledger_entries
              WHERE account_id = ANY($1::uuid[]))::int AS transactions,
            (SELECT count(*) FROM ledger_entries WHERE account_id = ANY($1::uuid[]))::int AS entries,
            (SELECT count(*) FROM audit_records WHERE account_ids && $1::uuid[])::int AS audits`,
    [accountIds],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('count returned no row');
  return row;
}

/** Whether an idempotency record exists for a user's key. */
export async function keyRowExists(userId: string, key: string): Promise<boolean> {
  const result = await runtimePool().query(
    'SELECT 1 FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  return result.rowCount === 1;
}

export interface ReversalAudit {
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  transaction_id: string | null;
  reversed_transaction_id: string | null;
  reason: string | null;
  request_id: string;
  created_at: Date | null;
}

/** The audit records of action `reversal` for an original transaction. */
export async function reversalAuditsOf(originalId: string): Promise<ReversalAudit[]> {
  const result = await runtimePool().query<ReversalAudit>(
    `SELECT actor_id, actor_role, action, account_ids::text[] AS account_ids, transaction_id,
            reversed_transaction_id, reason, request_id, created_at
     FROM audit_records WHERE action = 'reversal' AND reversed_transaction_id = $1`,
    [originalId],
  );
  return result.rows;
}

/** The reconciliation of spec 002 over the shared test database. */
export async function reconciliation(): Promise<{ report: ReconciliationReport; exitCode: 0 | 1 }> {
  // The Kysely instance is not destroyed: it would end the shared runtime pool.
  return await reconcile(new KyselyReconciliation(createDatabase(runtimePool())));
}
