import { z } from 'zod';
import { amountSchema } from '../../../../platform/http/schemas/amount.js';
import { currencySchema } from '../../../../platform/http/schemas/currency.js';
import { parseUuid, uuidSchema } from '../../../../platform/http/schemas/ids.js';

const ABOVE_MAXIMUM = 'Must not be greater than the maximum amount of one movement.';
const SAME_ACCOUNT = 'Must be another account than the source account.';

/**
 * The amount of a deposit, withdrawal or transfer: the shared amount schema (SYS-R07), refined to
 * at most `MAX_AMOUNT_MINOR` (LED-R23, LED-R24). An amount the shared schema refuses never reaches
 * the refinement, so every amount gets one issue, whose message holds no part of the value.
 */
function movementAmount(maxAmountMinor: bigint) {
  return amountSchema.refine((amount) => amount <= maxAmountMinor, { error: ABOVE_MAXIMUM });
}

/** The body of a deposit or withdrawal: an amount and a currency, nothing else (MOV-R08, MOV-R09). */
export function movementBody(maxAmountMinor: bigint) {
  return z.strictObject({ amount: movementAmount(maxAmountMinor), currency: currencySchema });
}

/**
 * The body of a transfer: a destination UUID in canonical lowercase, an amount and a currency
 * (MOV-R08 to MOV-R10, MOV-R30). With the path's `sourceId`, a destination equal to it in any
 * letter case is refused too; a path id that is not a UUID is left to the lookup (SYS-R42). A
 * route registers the body without a source, since its schema cannot see the path, and checks the
 * body again with it.
 */
export function transferBody(maxAmountMinor: bigint, sourceId?: string) {
  const source = sourceId === undefined ? undefined : parseUuid(sourceId);
  return z.strictObject({
    destinationAccountId: uuidSchema.refine((id) => id !== source, { error: SAME_ACCOUNT }),
    amount: movementAmount(maxAmountMinor),
    currency: currencySchema,
  });
}

const VISIBLE = /\S/;
const REASON_RULE =
  'Must be a string of 3 to 500 characters, without control characters, and not only whitespace.';

/**
 * Whether a reason holds 3 to 500 Unicode code points, counted with the string iterator as sent,
 * without trimming, none of them U+0000 to U+001F or U+007F, and not only whitespace (REV-R14).
 */
function isValidReason(reason: string): boolean {
  let codePoints = 0;
  for (const character of reason) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
    codePoints += 1;
  }
  return codePoints >= 3 && codePoints <= 500 && VISIBLE.test(reason);
}

/** The reason of a reversal: one issue whatever fails, whose message holds no part of the value. */
const reasonSchema = z
  .string({ error: (issue) => (issue.input === undefined ? 'Required.' : REASON_RULE) })
  .refine(isValidReason, { error: REASON_RULE });

/** The body of a reversal: a reason and nothing else (REV-R14). */
export const reversalBody = z.strictObject({ reason: reasonSchema });

/** A path id stays a plain string: one that is not a UUID answers 404 at the lookup (SYS-R42). */
export const idParams = z.object({ id: z.string() });

/** The query string of every route of this module: any parameter is unknown (AUT-R09). */
export const noQuery = z.strictObject({});

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const positiveAmount = z.string().regex(/^[1-9][0-9]*$/);

/** The response of a deposit, section 1.2 of spec 003: no account and no balance (MOV-R25). */
export const depositRepresentation = z.strictObject({
  id: z.guid(),
  kind: z.literal('deposit'),
  amount: positiveAmount,
  currency: currencySchema,
  createdAt: timestamp,
});

/** The response of a withdrawal or transfer: also the caller's source and its balance (MOV-R25). */
export const accountMovementRepresentation = z.strictObject({
  id: z.guid(),
  kind: z.enum(['withdrawal', 'transfer']),
  amount: positiveAmount,
  currency: currencySchema,
  createdAt: timestamp,
  accountId: z.guid(),
  balance: z.string().regex(/^(0|[1-9][0-9]*)$/),
});

/** The response of a reversal, section 1.3 of spec 004: no balance and no reason (REV-R16). */
export const reversalRepresentation = z.strictObject({
  id: z.guid(),
  kind: z.literal('reversal'),
  amount: positiveAmount,
  currency: currencySchema,
  createdAt: timestamp,
  reversedTransactionId: z.guid(),
});

/** The transaction representation of section 1.3 of spec 003, with signed entry amounts. */
export const transactionRepresentation = z.strictObject({
  id: z.guid(),
  kind: z.enum(['deposit', 'withdrawal', 'transfer', 'reversal']),
  amount: positiveAmount,
  currency: currencySchema,
  createdAt: timestamp,
  reversedTransactionId: z.guid().optional(),
  entries: z.array(
    z.strictObject({ accountId: z.guid(), amount: z.string().regex(/^-?[1-9][0-9]*$/) }),
  ),
});
