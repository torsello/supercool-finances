import { Account, type StatusAction } from '../domain/account.js';
import { NotFound } from '../domain/errors.js';
import { parseAccountId } from './account-id.js';
import type { AccountRecord, AccountTransactions } from './ports.js';

export interface ChangeAccountStatusCommand {
  /** The id from the path, not yet parsed. */
  accountId: string;
  action: StatusAction;
  actor: { id: string; role: 'operator' };
  requestId: string;
}

/**
 * Freezes, unfreezes or closes a customer account (plan 001 section 3.5): the row is locked within
 * the account lock timeout, the domain decides from the locked row, and a change is written with
 * its audit record in the same transaction. An unchanged status writes nothing (ACC-R15); a refused
 * change and a lock timeout roll back (ACC-R14, ACC-R16, ACC-R29).
 */
export async function changeAccountStatus(
  deps: { transactions: AccountTransactions; accountLockTimeoutMs: number },
  command: ChangeAccountStatusCommand,
): Promise<AccountRecord> {
  const id = parseAccountId(command.accountId);
  if (id === undefined) throw new NotFound();

  return await deps.transactions.run(async (tx) => {
    await tx.setLockTimeout(deps.accountLockTimeoutMs);
    const locked = await tx.accounts.lockForStatusChange(id);
    if (locked === undefined) throw new NotFound();

    const decision = Account.restore(locked).changeStatus(command.action);
    if (decision.kind === 'unchanged') return locked;

    const updated = await tx.accounts.updateStatus(id, decision.status);
    await tx.audit.record({
      actorId: command.actor.id,
      actorRole: command.actor.role,
      action: command.action,
      accountIds: [id],
      oldStatus: locked.status,
      newStatus: decision.status,
      requestId: command.requestId,
    });
    return updated;
  });
}
