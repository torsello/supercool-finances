import type { CurrencyCode } from '../../ledger/index.js';
import { Account } from '../domain/account.js';
import type { AccountRecord, AccountRepository, IdGenerator } from './ports.js';

export interface CreateAccountCommand {
  /** The caller, a customer (ACC-R06 is checked at the role step). */
  ownerId: string;
  currency: CurrencyCode;
}

/**
 * Opens a customer account for the caller, `active` with balance 0 (ACC-R01). Every call creates
 * one, with no limit per customer or currency (ACC-R02, ACC-R04); it looks nothing up and locks
 * nothing (plan 001 section 3.1).
 */
export async function createAccount(
  deps: { accounts: AccountRepository; ids: IdGenerator },
  command: CreateAccountCommand,
): Promise<AccountRecord> {
  const account = Account.open({
    id: deps.ids.next(),
    ownerId: command.ownerId,
    currency: command.currency,
  });
  return await deps.accounts.insert(account);
}
