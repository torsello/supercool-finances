import { NotFound, type Viewer } from '../../accounts/index.js';
import type { CurrencyCode, TransactionKind } from '../../ledger/index.js';
import type { TransactionQueries } from './ports.js';
import { parseUuid } from './steps.js';

/** The transaction representation of section 1.3 of spec 003. */
export interface TransactionView {
  id: string;
  kind: TransactionKind;
  /** The sum of the positive entries: the amount moved, for every kind. */
  amount: bigint;
  currency: CurrencyCode;
  createdAt: string;
  /** Present for a reversal only (REV-R23). */
  reversedTransactionId?: string;
  entries: { accountId: string; amount: bigint }[];
}

/**
 * Reads a transaction (plan 003 section 3.5): an operator sees every entry (MOV-R26), a customer
 * only those of their own accounts (MOV-R27); a customer with none, an unknown id and an id that
 * is not a UUID are one `NotFound` (MOV-R28).
 */
export async function getTransaction(
  queries: TransactionQueries,
  viewer: Viewer,
  rawId: string,
): Promise<TransactionView> {
  const id = parseUuid(rawId);
  if (id === undefined) throw new NotFound();
  const stored = await queries.findTransaction(id);
  if (stored === undefined) throw new NotFound();

  const visible =
    viewer.role === 'operator'
      ? stored.entries
      : stored.entries.filter((entry) => entry.ownerId === viewer.userId);
  if (visible.length === 0) throw new NotFound();

  const amount = stored.entries.reduce(
    (sum, entry) => (entry.amount > 0n ? sum + entry.amount : sum),
    0n,
  );
  return {
    id: stored.id,
    kind: stored.kind,
    amount,
    currency: stored.currency,
    createdAt: stored.createdAt,
    ...(stored.reversedTransactionId === null
      ? {}
      : { reversedTransactionId: stored.reversedTransactionId }),
    entries: visible.map((entry) => ({ accountId: entry.accountId, amount: entry.amount })),
  };
}
