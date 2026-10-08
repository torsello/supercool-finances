import { z } from 'zod';
import { currencySchema } from '../../../../platform/http/schemas/currency.js';

/** The body of `POST /accounts`: a currency and nothing else (ACC-R05, AUT-R09). */
export const createAccountBody = z.strictObject({ currency: currencySchema });

const LIMIT_RULE = 'Must be an integer from 1 to 100.';

/** `limit`, a query string value: an integer from 1 to 100, 20 when absent (ACC-R24). */
const limitSchema = z
  .string({ error: LIMIT_RULE })
  .regex(/^[1-9][0-9]*$/, { error: LIMIT_RULE })
  .refine((value) => value.length <= 3 && Number(value) <= 100, { error: LIMIT_RULE })
  .transform((value) => Number(value));

/**
 * The query string of both lists: `limit` and `cursor`, nothing else (AUT-R09). The cursor is a
 * plain string here: it is checked at the malformed-request step, before validation (plan 000
 * section 5, ACC-R23).
 */
export const listQuery = z.strictObject({
  limit: limitSchema.optional(),
  cursor: z.string().optional(),
});

/** The query string of a route that defines no parameter: any parameter is unknown (AUT-R09). */
export const noQuery = z.strictObject({});

/**
 * The body of a status change: none, or an empty JSON object, since section 1.1 of spec 001
 * defines no member; any member is unknown (AUT-R09). Fastify validates an absent body as `null`,
 * so `null` stands for no body.
 */
export const statusChangeBody = z.strictObject({}).nullish();

/** The default page size (section 1.5 of spec 001). */
export const DEFAULT_LIMIT = 20;

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** The account representation of section 1.3 of spec 001, exactly these members. */
export const accountRepresentation = z.strictObject({
  id: z.guid(),
  currency: currencySchema,
  status: z.enum(['active', 'frozen', 'closed']),
  balance: z.string().regex(/^(0|[1-9][0-9]*)$/),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** The operator's view: the account representation with `ownerId` (ACC-R10). */
export const operatorAccountRepresentation = accountRepresentation.extend({ ownerId: z.guid() });

/** The history entry representation of section 1.4 of spec 001. */
export const entryRepresentation = z.strictObject({
  id: z.guid(),
  transactionId: z.guid(),
  kind: z.enum(['deposit', 'withdrawal', 'transfer', 'reversal']),
  amount: z.string().regex(/^-?[1-9][0-9]*$/),
  currency: currencySchema,
  createdAt: timestamp,
});

function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: z.string().optional() });
}

export const accountPage = pageOf(accountRepresentation);
export const entryPage = pageOf(entryRepresentation);
