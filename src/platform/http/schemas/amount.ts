import { z } from 'zod';
import { MAX_MINOR_UNITS } from '../../../modules/ledger/index.js';

const DIGITS = /^[1-9][0-9]*$/;

const AMOUNT_RULE =
  'Must be a string of decimal digits without sign, leading zero, separator or exponent, from 1 to 9223372036854775807 minor units.';

/**
 * An amount the API accepts (SYS-R06, SYS-R07, ADR-0011): a JSON string of decimal digits without
 * sign, leading zero, separator or exponent, from 1 to 9223372036854775807 minor units, as a
 * `bigint`. Every failure gives one issue whose message holds no part of the value. The maximum per
 * movement, `MAX_AMOUNT_MINOR`, is refined by the movement schemas (plan 002).
 */
export const amountSchema = z
  .string({ error: (issue) => (issue.input === undefined ? 'Required.' : AMOUNT_RULE) })
  .refine((value) => DIGITS.test(value) && BigInt(value) <= MAX_MINOR_UNITS, { error: AMOUNT_RULE })
  .transform((value) => BigInt(value));
