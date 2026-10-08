const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An account id from a path, in canonical lowercase; `undefined` when it is not a UUID, which the
 * caller answers as an unknown account at the lookup step, without a query (SYS-R42).
 */
export function parseAccountId(raw: string): string | undefined {
  return UUID.test(raw) ? raw.toLowerCase() : undefined;
}
