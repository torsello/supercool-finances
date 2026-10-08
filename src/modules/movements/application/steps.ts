import { Account } from '../../accounts/index.js';
import { planLocks } from '../domain/lock-plan.js';
import type {
  AccountLookup,
  LockedAccount,
  MovementSettings,
  MovementTransaction,
} from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id in canonical lowercase, or `undefined` when it is not a UUID (MOV-R30, SYS-R42). */
export function parseUuid(raw: string): string | undefined {
  return UUID.test(raw) ? raw.toLowerCase() : undefined;
}

/**
 * Step 7 of the skeleton: the account lock timeout, set right before the first lock (MOV-R19),
 * then one `FOR UPDATE` per customer account in the order of the lock plan (MOV-R18).
 */
export async function lockAccounts(
  tx: MovementTransaction,
  settings: MovementSettings,
  accounts: readonly Pick<AccountLookup, 'id' | 'kind'>[],
): Promise<Map<string, LockedAccount>> {
  await tx.setLockTimeout(settings.accountLockTimeoutMs);
  const locked = new Map<string, LockedAccount>();
  for (const id of planLocks(accounts)) {
    const row = await tx.accounts.lock(id);
    if (row !== undefined) locked.set(id, row);
  }
  return locked;
}

/** The customer account as read under its lock, for the rules of section 1.4 of spec 003. */
export function lockedAccount(
  lookup: AccountLookup,
  locked: ReadonlyMap<string, LockedAccount>,
): Account {
  const row = locked.get(lookup.id);
  // A customer account's kind and owner never change, so a found customer account is locked.
  if (row === undefined || lookup.ownerId === null) {
    throw new Error(`customer account ${lookup.id} was not locked`);
  }
  return Account.restore({
    id: lookup.id,
    ownerId: lookup.ownerId,
    currency: lookup.currency,
    status: row.status,
    balance: row.balance,
  });
}
