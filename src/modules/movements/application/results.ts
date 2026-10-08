import type { CurrencyCode } from '../../ledger/index.js';

/** A movement that was applied (section 1.2 of spec 003). */
export interface MovementResult {
  transactionId: string;
  kind: 'deposit' | 'withdrawal' | 'transfer';
  amount: bigint;
  currency: CurrencyCode;
  createdAt: string;
}

/** A withdrawal or transfer: also the caller's own source account and its balance (MOV-R25). */
export interface AccountMovementResult extends MovementResult {
  accountId: string;
  balance: bigint;
}

/** A reversal that was applied (section 1.3 of spec 004): no balance and no reason (REV-R16). */
export interface ReversalResult {
  transactionId: string;
  kind: 'reversal';
  /** The original's amount. */
  amount: bigint;
  currency: CurrencyCode;
  createdAt: string;
  reversedTransactionId: string;
}
