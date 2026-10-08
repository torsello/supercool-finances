import { NotFound } from '../../accounts/index.js';
import type { CurrencyCode } from '../../ledger/index.js';
import { CurrencyMismatch } from '../domain/errors.js';
import { transferTransaction, type Destination } from '../domain/movement-rules.js';
import type {
  AccountLookup,
  LockedAccount,
  MovementSettings,
  MovementTransaction,
} from './ports.js';
import type { AccountMovementResult } from './results.js';
import { lockAccounts, lockedAccount, parseUuid } from './steps.js';

export interface TransferCommand {
  /** The source id from the path, not yet parsed. */
  accountId: string;
  /** Validated at the HTTP edge: a UUID other than the source (MOV-R10). */
  destinationAccountId: string;
  amount: bigint;
  currency: CurrencyCode;
  actor: { id: string; role: 'customer' };
  requestId: string;
}

function destinationOf(
  row: AccountLookup | undefined,
  locked: ReadonlyMap<string, LockedAccount>,
): Destination {
  if (row === undefined) return { kind: 'missing' };
  if (row.kind === 'system') return { kind: 'system' };
  return { kind: 'customer', account: lockedAccount(row, locked) };
}

/**
 * Steps 6 to 8 of a transfer (plan 003 section 3.3): lookup and ownership of the source,
 * currency, the locks in ascending order, the source's checks, the destination's, then the ledger
 * and the audit record. A system destination is never locked (MOV-R18).
 */
export async function transfer(
  tx: MovementTransaction,
  settings: MovementSettings,
  command: TransferCommand,
): Promise<AccountMovementResult> {
  const sourceId = parseUuid(command.accountId);
  if (sourceId === undefined) throw new NotFound();
  const destinationId = parseUuid(command.destinationAccountId);
  if (destinationId === undefined || destinationId === sourceId) {
    throw new RangeError('the destination is validated before the transfer runs');
  }

  const rows = await tx.accounts.findAccounts([sourceId, destinationId]);
  const source = rows.find((row) => row.id === sourceId);
  if (source === undefined || source.kind !== 'customer' || source.ownerId !== command.actor.id) {
    throw new NotFound();
  }
  if (command.currency !== source.currency) throw new CurrencyMismatch();
  const destinationRow = rows.find((row) => row.id === destinationId);

  const locked = await lockAccounts(
    tx,
    settings,
    destinationRow === undefined ? [source] : [source, destinationRow],
  );
  const transaction = transferTransaction(
    command.actor.id,
    lockedAccount(source, locked),
    destinationOf(destinationRow, locked),
    command.amount,
  );
  const appended = await tx.ledger.append(transaction);
  await tx.audit.record({
    actorId: command.actor.id,
    actorRole: command.actor.role,
    action: 'transfer',
    accountIds: [sourceId, destinationId],
    transactionId: appended.transactionId,
    requestId: command.requestId,
  });
  const balance = appended.balances.get(sourceId);
  if (balance === undefined) throw new Error(`no balance change for account ${sourceId}`);
  return {
    transactionId: appended.transactionId,
    kind: 'transfer',
    amount: command.amount,
    currency: source.currency,
    createdAt: appended.createdAt,
    accountId: sourceId,
    balance,
  };
}
