const MICROSECONDS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;

/**
 * A stored timestamp as the API writes it: RFC 3339 in UTC with milliseconds, truncated from the
 * stored microseconds, never rounded through a `Date` (section 1.5 of spec 001, plan 001 section 5).
 */
export function apiTimestamp(stored: string): string {
  const match = MICROSECONDS.exec(stored);
  if (match === null) throw new Error('a stored timestamp is not in microsecond RFC 3339 form');
  return `${match[1] ?? ''}Z`;
}
