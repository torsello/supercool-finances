import { sql, type Kysely } from 'kysely';
import { KyselyAuditLog } from '../../../../platform/audit/kysely-audit-log.js';
import type { CurrencyCode, Database, TimestampText } from '../../../../platform/db/schema.js';
import { clockTimestamp, timestampText } from '../../../../platform/db/timestamp.js';
import type { UnitOfWorkRunner } from '../../../../platform/db/unit-of-work.js';
import type { Account, AccountStatus } from '../../domain/account.js';
import type { Position } from '../../application/keyset.js';
import type {
  AccountQueries,
  AccountRecord,
  AccountRepository,
  AccountTransactions,
  HistoryEntryKind,
  HistoryEntryRecord,
  IdGenerator,
  StatusChangeTransaction,
} from '../../application/ports.js';

interface AccountRow {
  id: string;
  owner_id: string | null;
  currency: CurrencyCode;
  status: AccountStatus | null;
  balance: string | null;
  created_at: TimestampText;
  updated_at: TimestampText;
}

const ACCOUNT_COLUMNS = [
  'id',
  'owner_id',
  'currency',
  'status',
  'balance',
  timestampText('created_at').as('created_at'),
  timestampText('updated_at').as('updated_at'),
] as const;

/** A customer account row; the queries select customer rows only, so the nulls never occur. */
function toRecord(row: AccountRow): AccountRecord {
  if (row.owner_id === null || row.status === null || row.balance === null) {
    throw new Error(`account ${row.id} is not a customer account`);
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    currency: row.currency,
    status: row.status,
    balance: BigInt(row.balance),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The keyset condition `(created_at, id) < (position)` at microsecond precision (ACC-R22). */
function strictlyAfter(createdAt: string, id: string, position: Position) {
  return sql<boolean>`(${sql.ref(createdAt)}, ${sql.ref(id)}) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

/** The statements of plan 001 sections 3.1 and 3.5, on the executor it is given. */
export class KyselyAccountRepository implements AccountRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async insert(account: Account): Promise<AccountRecord> {
    const row = await this.db
      .insertInto('accounts')
      .values({
        id: account.id,
        kind: 'customer',
        owner_id: account.ownerId,
        currency: account.currency,
        status: account.status,
        balance: account.balance.toString(),
      })
      .returning(ACCOUNT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }

  async lockForStatusChange(id: string): Promise<AccountRecord | undefined> {
    const row = await this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .where('kind', '=', 'customer')
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async updateStatus(id: string, status: AccountStatus): Promise<AccountRecord> {
    const row = await this.db
      .updateTable('accounts')
      .set({ status, updated_at: clockTimestamp() })
      .where('id', '=', id)
      .where('kind', '=', 'customer')
      .returning(ACCOUNT_COLUMNS)
      .executeTakeFirstOrThrow();
    return toRecord(row);
  }
}

/** The reads of plan 001 sections 3.2 to 3.4, single statements outside a transaction. */
export class KyselyAccountQueries implements AccountQueries {
  constructor(private readonly db: Kysely<Database>) {}

  async findCustomerAccount(id: string, ownerId?: string): Promise<AccountRecord | undefined> {
    let query = this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('id', '=', id)
      .where('kind', '=', 'customer');
    if (ownerId !== undefined) query = query.where('owner_id', '=', ownerId);
    const row = await query.executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async listOwned(ownerId: string, limit: number, after?: Position): Promise<AccountRecord[]> {
    let query = this.db
      .selectFrom('accounts')
      .select(ACCOUNT_COLUMNS)
      .where('owner_id', '=', ownerId)
      .where('kind', '=', 'customer');
    if (after !== undefined) query = query.where(strictlyAfter('created_at', 'id', after));
    // The table column, not the selected text of the same name, so accounts_owner_list serves it.
    const rows = await query
      .orderBy(sql.ref('accounts.created_at'), 'desc')
      .orderBy('accounts.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toRecord);
  }

  async listEntries(
    accountId: string,
    limit: number,
    after?: Position,
  ): Promise<HistoryEntryRecord[]> {
    let query = this.db
      .selectFrom('ledger_entries as e')
      .innerJoin('transactions as t', 't.id', 'e.transaction_id')
      .select([
        'e.id',
        'e.transaction_id',
        't.kind',
        'e.amount',
        'e.currency',
        timestampText('e.created_at').as('created_at'),
      ])
      .where('e.account_id', '=', accountId);
    if (after !== undefined) query = query.where(strictlyAfter('e.created_at', 'e.id', after));
    const rows = await query
      .orderBy(sql`e.created_at`, 'desc')
      .orderBy('e.id', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      kind: row.kind satisfies HistoryEntryKind,
      amount: BigInt(row.amount),
      currency: row.currency,
      createdAt: row.created_at,
    }));
  }
}

/** Status changes in one transaction of the unit-of-work runner, never retried (plan 001 section 3.5). */
export class KyselyAccountTransactions implements AccountTransactions {
  constructor(
    private readonly unitOfWork: UnitOfWorkRunner,
    private readonly ids: IdGenerator,
  ) {}

  async run<T>(work: (tx: StatusChangeTransaction) => Promise<T>): Promise<T> {
    return await this.unitOfWork.run(
      async (uow) =>
        await work({
          setLockTimeout: async (ms) => {
            await uow.setLockTimeout(ms);
          },
          accounts: new KyselyAccountRepository(uow.db),
          audit: new KyselyAuditLog(uow.db, this.ids),
        }),
      { retry: 'none' },
    );
  }
}
