import type { z } from 'zod';
import type { AccountRecord, CustomerAccountView, HistoryEntryRecord } from '../../index.js';
import type {
  accountRepresentation,
  entryRepresentation,
  operatorAccountRepresentation,
} from './schemas.js';

const MICROSECONDS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/**
 * A stored timestamp as the API writes it: RFC 3339 in UTC with milliseconds, truncated from the
 * stored microseconds, never rounded through a `Date` (section 1.5 of spec 001, plan 001 section 5).
 */
export function apiTimestamp(stored: string): string {
  const match = MICROSECONDS.exec(stored);
  if (match === null) throw new Error('a stored timestamp is not in microsecond RFC 3339 form');
  return `${match[1] ?? ''}Z`;
}

/** The account representation of section 1.3 of spec 001. */
export type AccountBody = z.output<typeof accountRepresentation>;

/** The operator's view: the same representation with `ownerId` added (ACC-R10). */
export type OperatorAccountBody = z.output<typeof operatorAccountRepresentation>;

/** The history entry representation of section 1.4 of spec 001. */
export type EntryBody = z.output<typeof entryRepresentation>;

/** One page: `nextCursor` only when another page follows (ACC-AC27). */
export interface PageBody<T> {
  items: T[];
  nextCursor?: string;
}

export function accountBody(account: CustomerAccountView): AccountBody {
  return {
    id: account.id,
    currency: account.currency,
    status: account.status,
    balance: account.balance.toString(),
    createdAt: apiTimestamp(account.createdAt),
    updatedAt: apiTimestamp(account.updatedAt),
  };
}

export function operatorAccountBody(account: AccountRecord): OperatorAccountBody {
  return { ...accountBody(account), ownerId: account.ownerId };
}

/** A read's body: the operator view when the query service returned the owner, else the customer view. */
export function readBody(
  account: CustomerAccountView | AccountRecord,
): AccountBody | OperatorAccountBody {
  return 'ownerId' in account ? operatorAccountBody(account) : accountBody(account);
}

export function entryBody(entry: HistoryEntryRecord): EntryBody {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    kind: entry.kind,
    amount: entry.amount.toString(),
    currency: entry.currency,
    createdAt: apiTimestamp(entry.createdAt),
  };
}

export function pageBody<T>(items: T[], nextCursor: string | undefined): PageBody<T> {
  return nextCursor === undefined ? { items } : { items, nextCursor };
}
