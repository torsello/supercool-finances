import { sql, type RawBuilder } from 'kysely';
import type { ClockTimestamp, TimestampText } from './schema.js';

/** `to_char` format of an RFC 3339 UTC timestamp with microseconds (plan 001 section 5). */
const RFC3339_MICROS = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';

/**
 * Reads a `timestamptz` column, such as `created_at` or `e.created_at`, as an RFC 3339 string with
 * microseconds, never through a JavaScript `Date`. SQL casts it back to `timestamptz` exactly.
 */
export function timestampText(column: string): RawBuilder<TimestampText> {
  return sql<TimestampText>`to_char(${sql.ref(column)} AT TIME ZONE 'UTC', ${RFC3339_MICROS})`;
}

/** The database clock at the moment of the statement, for `updated_at` (plan 001 section 2). */
export function clockTimestamp(): RawBuilder<ClockTimestamp> {
  return sql<ClockTimestamp>`clock_timestamp()`;
}
