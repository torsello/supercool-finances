import { NotFound } from '../../accounts/index.js';
import type { CurrencyCode } from '../../ledger/index.js';
import { CurrencyMismatch } from '../domain/errors.js';
import { withdrawalTransaction } from '../domain/movement-rules.js';
import type { MovementSettings, MovementTransaction } from './ports.js';
import type { AccountMovementResult } from './results.js';
import { lockAccounts, lockedAccount, parseUuid } from './steps.js';

export interface WithdrawCommand {
  /** The id from the path, not yet parsed. */
  accountId: string;
  amount: bigint;
  currency: CurrencyCode;
  actor: { id: string; role: 'customer' };
  requestId: string;
}

/**
 * Steps 6 to 8 of a withdrawal (plan 003 section 3.2): lookup and ownership, currency, the lock,
 * the status and the funds, then the ledger and the audit record.
 */
export async function withdraw(
  tx: MovementTransaction,
  settings: MovementSettings,
  command: WithdrawCommand,
): Promise<AccountMovementResult> {
  const id = parseUuid(command.accountId);
  if (id === undefined) throw new NotFound();
  const source = await tx.accounts.findWithSettlement(id);
  if (source === undefined || source.kind !== 'customer' || source.ownerId !== command.actor.id) {
    throw new NotFound();
  }
  if (command.currency !== source.currency) throw new CurrencyMismatch();

  const locked = await lockAccounts(tx, settings, [source]);
  const transaction = withdrawalTransaction(
    lockedAccount(source, locked),
    { id: source.settlementId, currency: source.currency },
    command.amount,
  );
  const appended = await tx.ledger.append(transaction);
  await tx.audit.record({
    actorId: command.actor.id,
    actorRole: command.actor.role,
    action: 'withdrawal',
    accountIds: [id],
    transactionId: appended.transactionId,
    requestId: command.requestId,
  });
  const balance = appended.balances.get(id);
  if (balance === undefined) throw new Error(`no balance change for account ${id}`);
  return {
    transactionId: appended.transactionId,
    kind: 'withdrawal',
    amount: command.amount,
    currency: source.currency,
    createdAt: appended.createdAt,
    accountId: id,
    balance,
  };
}
