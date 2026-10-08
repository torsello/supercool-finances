/**
 * The customer accounts a movement locks, in the order it locks them (MOV-R18, MOV-R30): every id
 * in canonical lowercase, without duplicates, ascending. Canonical lowercase UUIDs sort as plain
 * strings in byte order, which is PostgreSQL's `uuid` order. System accounts are never locked
 * (LED-R14); ids the lookup did not find are not passed in.
 */
export function planLocks(
  accounts: readonly { id: string; kind: 'customer' | 'system' }[],
): string[] {
  const ids = new Set(
    accounts
      .filter((account) => account.kind === 'customer')
      .map((account) => account.id.toLowerCase()),
  );
  return [...ids].sort();
}
