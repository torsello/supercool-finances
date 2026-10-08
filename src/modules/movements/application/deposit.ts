import { NotFound } from '../../accounts/index.js';
import type { CurrencyCode } from '../../ledger/index.js';
import { CurrencyMismatch } from '../domain/errors.js';
import { depositTransaction } from '../domain/movement-rules.js';
import type { MovementSettings, MovementTransaction } from './ports.js';
import type { MovementResult } from './results.js';
import { lockAccounts, lockedAccount, parseUuid } from './steps.js';

export interface DepositCommand {
  /** The id from the path, not yet parsed. */
  accountId: string;
  /** Validated at the HTTP edge: 1 to `MAX_AMOUNT_MINOR` (LED-R24). */
  amount: bigint;
  currency: CurrencyCode;
  actor: { id: string; role: 'operator' };
  requestId: string;
}

/**
 * Steps 6 to 8 of a deposit (plan 003 section 3.1) on the unit of work it is given: lookup,
 * currency, the lock, the status and the balance limit, then the ledger and the audit record.
 */
export async function deposit(
  tx: MovementTransaction,
  settings: MovementSettings,
  command: DepositCommand,
): Promise<MovementResult> {
  const id = parseUuid(command.accountId);
  if (id === undefined) throw new NotFound();
  const target = await tx.accounts.findWithSettlement(id);
  if (target === undefined || target.kind !== 'customer') throw new NotFound();
  if (command.currency !== target.currency) throw new CurrencyMismatch();

  const locked = await lockAccounts(tx, settings, [target]);
  const transaction = depositTransaction(
    lockedAccount(target, locked),
    { id: target.settlementId, currency: target.currency },
    command.amount,
  );
  const appended = await tx.ledger.append(transaction);
  await tx.audit.record({
    actorId: command.actor.id,
    actorRole: command.actor.role,
    action: 'deposit',
    accountIds: [id],
    transactionId: appended.transactionId,
    requestId: command.requestId,
  });
  return {
    transactionId: appended.transactionId,
    kind: 'deposit',
    amount: command.amount,
    currency: target.currency,
    createdAt: appended.createdAt,
  };
}
