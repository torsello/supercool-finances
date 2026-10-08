import type { z } from 'zod';
import { apiTimestamp } from '../../../../platform/http/timestamp.js';
import type { AccountRecord, CustomerAccountView, HistoryEntryRecord } from '../../index.js';
import type {
  accountRepresentation,
  entryRepresentation,
  operatorAccountRepresentation,
} from './schemas.js';

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
