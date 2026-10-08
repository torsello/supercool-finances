import type { Kysely } from 'kysely';
import { KyselyAuditLog } from '../../../../platform/audit/kysely-audit-log.js';
import type { Database } from '../../../../platform/db/schema.js';
import { timestampText } from '../../../../platform/db/timestamp.js';
import type { UnitOfWork, UnitOfWorkRunner } from '../../../../platform/db/unit-of-work.js';
import type { LedgerWriter, RecordedTransaction } from '../../../ledger/index.js';
import type {
  AccountLookup,
  AccountWithSettlement,
  IdGenerator,
  LockedAccount,
  MovementAccounts,
  MovementTransaction,
  MovementTransactions,
  StoredTransaction,
  TransactionLookup,
  TransactionQueries,
} from '../../application/ports.js';

/** The lookup and lock statements of plan 003 section 3, on the executor it is given. */
export class KyselyMovementAccounts implements MovementAccounts {
  constructor(private readonly db: Kysely<Database>) {}

  async findWithSettlement(id: string): Promise<AccountWithSettlement | undefined> {
    const row = await this.db
      .selectFrom('accounts as a')
      .innerJoin('accounts as s', (join) =>
        join.on('s.kind', '=', 'system').onRef('s.currency', '=', 'a.currency'),
      )
      .select(['a.id', 'a.kind', 'a.owner_id', 'a.currency', 's.id as settlement_id'])
      .where('a.id', '=', id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      ownerId: row.owner_id,
      currency: row.currency,
      settlementId: row.settlement_id,
    };
  }

  async findAccounts(ids: readonly string[]): Promise<AccountLookup[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .selectFrom('accounts')
      .select(['id', 'kind', 'owner_id', 'currency'])
      .where('id', 'in', ids)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      ownerId: row.owner_id,
      currency: row.currency,
    }));
  }

  async lock(id: string): Promise<LockedAccount | undefined> {
    // kind = 'customer' filters a system row before it is locked, so it is never waited for.
    const row = await this.db
      .selectFrom('accounts')
      .select(['id', 'status', 'balance'])
      .where('id', '=', id)
      .where('kind', '=', 'customer')
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return undefined;
    if (row.status === null || row.balance === null) {
      throw new Error(`account ${id} is not a customer account`);
    }
    return { id: row.id, status: row.status, balance: BigInt(row.balance) };
  }
}

/** The ledger reads of a reversal (plan 004 section 3), on the executor it is given, without locks. */
export class KyselyTransactionLookup implements TransactionLookup {
  constructor(private readonly db: Kysely<Database>) {}

  async findTransaction(id: string): Promise<RecordedTransaction | undefined> {
    const rows = await this.db
      .selectFrom('transactions as t')
      .innerJoin('ledger_entries as e', 'e.transaction_id', 't.id')
      .innerJoin('accounts as a', 'a.id', 'e.account_id')
      .select([
        't.id',
        't.kind',
        't.currency',
        'e.account_id',
        'e.amount',
        'e.currency as entry_currency',
        'a.kind as account_kind',
        'a.currency as account_currency',
      ])
      .where('t.id', '=', id)
      .orderBy('e.id')
      .execute();
    const first = rows[0];
    if (first === undefined) return undefined;
    return {
      id: first.id,
      kind: first.kind,
      currency: first.currency,
      entries: rows.map((row) => ({
        accountId: row.account_id,
        accountKind: row.account_kind,
        accountCurrency: row.account_currency,
        amount: BigInt(row.amount),
        currency: row.entry_currency,
      })),
    };
  }

  async findReversalOf(id: string): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('transactions')
      .select('id')
      .where('reversed_transaction_id', '=', id)
      .executeTakeFirst();
    return row?.id;
  }
}

/** The read of a transaction of plan 003 section 3.5: one statement, no transaction. */
export class KyselyTransactionQueries implements TransactionQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async findTransaction(id: string): Promise<StoredTransaction | undefined> {
    const rows = await this.db
      .selectFrom('transactions as t')
      .innerJoin('ledger_entries as e', 'e.transaction_id', 't.id')
      .innerJoin('accounts as a', 'a.id', 'e.account_id')
      .select([
        't.id',
        't.kind',
        't.currency',
        timestampText('t.created_at').as('created_at'),
        't.reversed_transaction_id',
        'e.account_id',
        'e.amount',
        'a.owner_id',
      ])
      .where('t.id', '=', id)
      .orderBy('e.id')
      .execute();
    const first = rows[0];
    if (first === undefined) return undefined;
    return {
      id: first.id,
      kind: first.kind,
      currency: first.currency,
      createdAt: first.created_at,
      reversedTransactionId: first.reversed_transaction_id,
      entries: rows.map((row) => ({
        accountId: row.account_id,
        amount: BigInt(row.amount),
        ownerId: row.owner_id,
      })),
    };
  }
}

/**
 * What a movement or reversal uses on one unit of work: steps 6 to 8 of the skeleton. The ledger
 * writer comes from the composition root, since one module's adapters never import another's.
 */
export interface MovementDependencies {
  ids: IdGenerator;
  ledger: (uow: UnitOfWork) => LedgerWriter;
}

/**
 * The ports of a movement on the given unit of work's connection: alone, or as the operation of
 * the idempotency module's keyed transactions, after the key step (plan 000 section 6.2).
 */
export function movementTransactionOn(
  uow: UnitOfWork,
  deps: MovementDependencies,
): MovementTransaction {
  return {
    setLockTimeout: async (ms) => {
      await uow.setLockTimeout(ms);
    },
    accounts: new KyselyMovementAccounts(uow.db),
    transactions: new KyselyTransactionLookup(uow.db),
    ledger: deps.ledger(uow),
    audit: new KyselyAuditLog(uow.db, deps.ids),
  };
}

/** Movements in one transaction of the unit-of-work runner, retried on 40P01 and 40001 (SYS-R18). */
export class KyselyMovementTransactions implements MovementTransactions {
  constructor(
    private readonly unitOfWork: UnitOfWorkRunner,
    private readonly deps: MovementDependencies,
  ) {}

  async run<T>(work: (tx: MovementTransaction) => Promise<T>): Promise<T> {
    return await this.unitOfWork.run(
      async (uow) => await work(movementTransactionOn(uow, this.deps)),
      { retry: 'movement' },
    );
  }
}
