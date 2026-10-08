import { NotFound } from '../domain/errors.js';
import { parseAccountId } from './account-id.js';
import { positionOf, type Position } from './keyset.js';
import type { AccountQueries, AccountRecord, HistoryEntryRecord, Viewer } from './ports.js';

/** The account representation a customer gets: no `ownerId` (section 1.3 of spec 001). */
export type CustomerAccountView = Omit<AccountRecord, 'ownerId'>;

/** One page, newest first; `next` is the position of its last item when more items follow. */
export interface Page<T> {
  items: T[];
  next: Position | undefined;
}

export interface PageRequest {
  /** 1 to 100, validated at the HTTP edge (ACC-R24). */
  limit: number;
  after?: Position;
}

function withoutOwner(account: AccountRecord): CustomerAccountView {
  const { id, currency, status, balance, createdAt, updatedAt } = account;
  return { id, currency, status, balance, createdAt, updatedAt };
}

/** Reads one row more than the page, which decides whether a next page exists (plan 001 section 3.3). */
async function page<T extends Position>(
  read: (limit: number) => Promise<T[]>,
  limit: number,
): Promise<Page<T>> {
  const rows = await read(limit + 1);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, next: rows.length > limit && last !== undefined ? positionOf(last) : undefined };
}

/**
 * The customer account a viewer may see: a customer only their own, an operator any; never a system
 * account (ACC-R09, ACC-R10, ACC-R25, SYS-R38). Anything else is `NotFound`.
 */
async function visibleAccount(
  queries: AccountQueries,
  viewer: Viewer,
  rawId: string,
): Promise<AccountRecord> {
  const id = parseAccountId(rawId);
  if (id === undefined) throw new NotFound();
  const account = await queries.findCustomerAccount(
    id,
    viewer.role === 'customer' ? viewer.userId : undefined,
  );
  if (account === undefined) throw new NotFound();
  return account;
}

/** Reads an account (ACC-R07); an operator also gets `ownerId` (ACC-R10). */
export async function readAccount(
  queries: AccountQueries,
  viewer: Viewer,
  rawId: string,
): Promise<CustomerAccountView | AccountRecord> {
  const account = await visibleAccount(queries, viewer, rawId);
  return viewer.role === 'operator' ? account : withoutOwner(account);
}

/** The caller's own accounts, in every status, newest first (ACC-R08); customers only (ACC-R27). */
export async function listAccounts(
  queries: AccountQueries,
  ownerId: string,
  request: PageRequest,
): Promise<Page<CustomerAccountView>> {
  const result = await page(
    (limit) => queries.listOwned(ownerId, limit, request.after),
    request.limit,
  );
  return { items: result.items.map(withoutOwner), next: result.next };
}

/** The entries of an account the viewer may see, newest first (ACC-R21, ACC-R22). */
export async function listHistory(
  queries: AccountQueries,
  viewer: Viewer,
  rawId: string,
  request: PageRequest,
): Promise<Page<HistoryEntryRecord>> {
  const account = await visibleAccount(queries, viewer, rawId);
  return await page(
    (limit) => queries.listEntries(account.id, limit, request.after),
    request.limit,
  );
}
