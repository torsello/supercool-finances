import type { z } from 'zod';
import { apiTimestamp } from '../../../../platform/http/timestamp.js';
import type {
  AccountMovementResult,
  MovementResult,
  ReversalResult,
  TransactionView,
} from '../../index.js';
import type {
  accountMovementRepresentation,
  depositRepresentation,
  reversalRepresentation,
  transactionRepresentation,
} from './schemas.js';

export type DepositBody = z.output<typeof depositRepresentation>;
export type AccountMovementBody = z.output<typeof accountMovementRepresentation>;
export type ReversalBody = z.output<typeof reversalRepresentation>;
export type TransactionBody = z.output<typeof transactionRepresentation>;

/** Where a movement's or reversal's transaction is read, `/v1` included (SYS-R43). */
export function transactionLocation(transactionId: string): string {
  return `/v1/transactions/${transactionId}`;
}

/** A deposit's response, section 1.2 of spec 003: no account and no balance (MOV-R25). */
export function depositBody(result: MovementResult): DepositBody {
  if (result.kind !== 'deposit') throw new Error(`a ${result.kind} is not a deposit`);
  return {
    id: result.transactionId,
    kind: result.kind,
    amount: result.amount.toString(),
    currency: result.currency,
    createdAt: apiTimestamp(result.createdAt),
  };
}

/**
 * A withdrawal's or transfer's response: also the caller's own source account and its balance
 * after the movement, never another account's (MOV-R25).
 */
export function accountMovementBody(result: AccountMovementResult): AccountMovementBody {
  if (result.kind === 'deposit') throw new Error('a deposit carries no account');
  return {
    id: result.transactionId,
    kind: result.kind,
    amount: result.amount.toString(),
    currency: result.currency,
    createdAt: apiTimestamp(result.createdAt),
    accountId: result.accountId,
    balance: result.balance.toString(),
  };
}

/** A reversal's response, section 1.3 of spec 004: no balance and never the reason (REV-R16). */
export function reversalBody(result: ReversalResult): ReversalBody {
  return {
    id: result.transactionId,
    kind: result.kind,
    amount: result.amount.toString(),
    currency: result.currency,
    createdAt: apiTimestamp(result.createdAt),
    reversedTransactionId: result.reversedTransactionId,
  };
}

/**
 * The transaction representation of section 1.3 of spec 003: the entries the viewer may see, and
 * `reversedTransactionId` only for a reversal (REV-R23).
 */
export function transactionBody(view: TransactionView): TransactionBody {
  return {
    id: view.id,
    kind: view.kind,
    amount: view.amount.toString(),
    currency: view.currency,
    createdAt: apiTimestamp(view.createdAt),
    ...(view.reversedTransactionId === undefined
      ? {}
      : { reversedTransactionId: view.reversedTransactionId }),
    entries: view.entries.map((entry) => ({
      accountId: entry.accountId,
      amount: entry.amount.toString(),
    })),
  };
}
