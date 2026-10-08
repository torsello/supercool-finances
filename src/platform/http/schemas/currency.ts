import { z } from 'zod';
import { CURRENCIES, type CurrencyCode } from '../../../modules/ledger/index.js';

const CODES = CURRENCIES.map((currency) => currency.code) as [CurrencyCode, ...CurrencyCode[]];

const CURRENCY_RULE = `Must be one of ${CODES.join(', ')}.`;

/** A currency code of table 1.3 of spec 000, exactly as written there (SYS-R08, SYS-R09). */
export const currencySchema = z.enum(CODES, {
  error: (issue) => (issue.input === undefined ? 'Required.' : CURRENCY_RULE),
});
