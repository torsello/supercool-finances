import type { CurrencyTotal, Discrepancy, ReconciliationQuery } from './ports.js';

export interface ReconciliationReport {
  discrepancies: Discrepancy[];
  totals: CurrencyTotal[];
}

/**
 * The report of section 1.5 of spec 002 and its exit code: 0 when no account drifted and every
 * global sum is "0", 1 otherwise (LED-R19, LED-R21). Exit 2, when it cannot run, is the CLI's.
 */
export async function reconcile(
  query: ReconciliationQuery,
): Promise<{ report: ReconciliationReport; exitCode: 0 | 1 }> {
  const discrepancies = await query.discrepancies();
  const totals = await query.totals();
  const clean = discrepancies.length === 0 && totals.every((total) => total.sum === '0');
  return { report: { discrepancies, totals }, exitCode: clean ? 0 : 1 };
}
