import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The canonical lowercase form of a UUID written in any letter case, or `undefined` for any other
 * text (MOV-R30). A path id that is not a UUID answers 404 at the lookup step (SYS-R42), so path ids
 * are parsed with this function, not by a route schema.
 */
export function parseUuid(value: string): string | undefined {
  return UUID.test(value) ? value.toLowerCase() : undefined;
}

/** A UUID in a body, in canonical lowercase (MOV-R30); anything else fails validation. */
export const uuidSchema = z
  .string({ error: (issue) => (issue.input === undefined ? 'Required.' : 'Must be a UUID.') })
  .regex(UUID, { error: 'Must be a UUID.' })
  .transform((value) => value.toLowerCase());
