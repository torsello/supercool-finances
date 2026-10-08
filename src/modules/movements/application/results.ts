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
