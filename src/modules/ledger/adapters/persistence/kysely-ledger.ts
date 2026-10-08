import { sql, type Kysely } from 'kysely';
import pg from 'pg';
import type { Database } from '../../../../platform/db/schema.js';
import { clockTimestamp, timestampText } from '../../../../platform/db/timestamp.js';
import type { UnitOfWork } from '../../../../platform/db/unit-of-work.js';
import { AlreadyReversed } from '../../domain/errors.js';
import type { LedgerTransaction } from '../../domain/ledger-transaction.js';
import type { AppendedTransaction, BalanceQueries, LedgerWriter } from '../../application/ports.js';

/** The unique constraint that keeps a transaction reversed at most once (REV-R05). */
const REVERSAL_LINK_KEY = 'transactions_reversed_transaction_id_key';

/**
 * A second reversal refused at its insert by the unique constraint of REV-R05: `AlreadyReversed`,
 * with only the SQLSTATE and constraint as cause, so no layer above reads a `pg` error (REV-R06).
 */
function asAlreadyReversed(error: unknown): unknown {
  if (
    error instanceof pg.DatabaseError &&
    error.code === '23505' &&
    error.constraint === REVERSAL_LINK_KEY
  ) {
    return new AlreadyReversed({ cause: { sqlstate: error.code, constraint: error.constraint } });
  }
  return error;
}

/**
 * Step 8 of the movement skeleton on the unit of work's connection, after the row locks (plan 002
 * section 4). It reports the end of the entries and of the balance changes to the unit of work,
 * where the fault seam can throw. No statement updates or locks a system account (LED-R14).
 */
export class KyselyLedgerWriter implements LedgerWriter {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: { next(): string },
  ) {}

  async append(transaction: LedgerTransaction): Promise<AppendedTransaction> {
    const transactionId = this.ids.next();
    const inserted = await this.uow.db
      .insertInto('transactions')
      .values({
        id: transactionId,
        kind: transaction.kind,
        currency: transaction.currency,
        reversed_transaction_id: transaction.reversedTransactionId,
      })
      .returning(timestampText('created_at').as('created_at'))
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        throw asAlreadyReversed(error);
      });

    // One statement for every entry; created_at is the column default, taken now (LED-R18).
    await this.uow.db
      .insertInto('ledger_entries')
      .values(
        transaction.entries.map((entry) => ({
          id: this.ids.next(),
          transaction_id: transactionId,
          account_id: entry.accountId,
          amount: entry.amount.toString(),
          currency: entry.currency,
        })),
      )
      .execute();
    this.uow.reached('after-entries');

    const balances = new Map<string, bigint>();
    for (const { accountId, change } of transaction.balanceChanges()) {
      const row = await this.uow.db
        .updateTable('accounts')
        .set({
          balance: sql<string>`balance + ${change.toString()}::bigint`,
          updated_at: clockTimestamp(),
        })
        .where('id', '=', accountId)
        .where('kind', '=', 'customer')
        .returning('balance')
        .executeTakeFirstOrThrow();
      if (row.balance === null) throw new Error(`account ${accountId} has no cached balance`);
      balances.set(accountId, BigInt(row.balance));
    }
    this.uow.reached('after-balances');

    return { transactionId, createdAt: inserted.created_at, balances };
  }
}

/** Balances derived from the entries, summed as `numeric` so they never overflow (LED-R15). */
export class KyselyBalanceQueries implements BalanceQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async entriesSum(accountId: string): Promise<string> {
    const row = await this.db
      .selectFrom('ledger_entries')
      .select(sql<string>`COALESCE(SUM(amount), 0)::text`.as('sum'))
      .where('account_id', '=', accountId)
      .executeTakeFirstOrThrow();
    return row.sum;
  }
}
