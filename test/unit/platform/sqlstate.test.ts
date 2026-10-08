import pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  AccountLockTimeout,
  IdempotencyWaitTimeout,
  LedgerWriteRejected,
  StatementTimeout,
} from '../../../src/platform/db/errors.js';
import { classifyDatabaseError, isRetryable } from '../../../src/platform/db/sqlstate.js';

function databaseError(
  code: string,
  fields: { constraint?: string; table?: string; where?: string } = {},
): pg.DatabaseError {
  const error = new pg.DatabaseError(`fake ${code}`, 0, 'error');
  error.code = code;
  error.constraint = fields.constraint;
  error.table = fields.table;
  error.where = fields.where;
  return error;
}

const STEPS = ['key-wait', 'work'] as const;

describe('SQLSTATE classification (plan 000 section 6.3)', () => {
  it('SYS-R19 marks 40P01 and 40001 retryable at any statement and leaves them for the runner', () => {
    for (const code of ['40P01', '40001']) {
      const error = databaseError(code);
      expect(isRetryable(error)).toBe(true);
      for (const step of STEPS) expect(classifyDatabaseError(error, step)).toBe(error);
    }
    expect(isRetryable(databaseError('55P03'))).toBe(false);
    expect(isRetryable(databaseError('23505'))).toBe(false);
    expect(isRetryable(new Error('40001'))).toBe(false);
  });

  it('IDM-R12 maps 55P03 at a key-wait step to IdempotencyWaitTimeout', () => {
    const error = databaseError('55P03');
    const classified = classifyDatabaseError(error, 'key-wait');
    expect(classified).toBeInstanceOf(IdempotencyWaitTimeout);
    expect(classified).toMatchObject({ cause: error });
  });

  it('MOV-R20 IDM-R13 maps 55P03 after the key-wait steps to AccountLockTimeout', () => {
    const error = databaseError('55P03');
    const classified = classifyDatabaseError(error, 'work');
    expect(classified).toBeInstanceOf(AccountLockTimeout);
    expect(classified).toMatchObject({ cause: error });
  });

  it('SEC-R32 maps 57014 at any step to StatementTimeout', () => {
    for (const step of STEPS) {
      expect(classifyDatabaseError(databaseError('57014'), step)).toBeInstanceOf(StatementTimeout);
    }
  });

  it('LED-R28 maps 23502, 23503, 23514 and P0001 from a ledger check of spec 002 to LedgerWriteRejected with its SQLSTATE and constraint', () => {
    const cases: [code: string, fields: Parameters<typeof databaseError>[1]][] = [
      ['23502', { table: 'transactions' }],
      ['23502', { table: 'ledger_entries' }],
      ['23503', { constraint: 'ledger_entries_transaction_id_currency_fkey' }],
      ['23503', { constraint: 'ledger_entries_account_id_currency_fkey' }],
      ['23503', { constraint: 'transactions_reversed_transaction_id_fkey' }],
      ['23514', { constraint: 'ledger_transaction_min_entries' }],
      ['23514', { constraint: 'ledger_transaction_one_currency' }],
      ['23514', { constraint: 'ledger_transaction_balanced' }],
      ['23514', { constraint: 'ledger_transaction_written_once' }],
      ['23514', { constraint: 'ledger_entries_amount_not_zero' }],
      ['23514', { constraint: 'transactions_reversal_link' }],
      ['23514', { constraint: 'transactions_kind_check' }],
      ['23514', { constraint: 'transactions_currency_check' }],
      ['23514', { constraint: 'accounts_balance_check' }],
      ['23514', { constraint: 'accounts_kind_columns' }],
      ['P0001', { where: 'PL/pgSQL function ledger_refuse_change() line 3 at RAISE' }],
    ];
    for (const [code, fields] of cases) {
      for (const step of STEPS) {
        const error = databaseError(code, fields);
        const classified = classifyDatabaseError(error, step);
        expect(classified).toBeInstanceOf(LedgerWriteRejected);
        expect(classified).toMatchObject({
          sqlstate: code,
          constraint: fields?.constraint,
          cause: error,
        });
      }
    }
  });

  it('LED-R28 leaves 23514 on idempotency_keys_complete at COMMIT as it is: a defect answered 500', () => {
    const error = databaseError('23514', { constraint: 'idempotency_keys_complete' });
    expect(classifyDatabaseError(error, 'work')).toBe(error);
  });

  it('REV-R06 leaves 23505 on transactions_reversed_transaction_id_key to the ledger adapter', () => {
    const error = databaseError('23505', {
      constraint: 'transactions_reversed_transaction_id_key',
    });
    for (const step of STEPS) expect(classifyDatabaseError(error, step)).toBe(error);
  });

  it('LED-R28 rethrows anything else as it is', () => {
    const others = [
      databaseError('23502', { table: 'audit_records' }),
      databaseError('23503', { constraint: 'audit_records_transaction_id_fkey' }),
      databaseError('23514', { constraint: 'accounts_closed_is_empty' }),
      databaseError('23514'),
      databaseError('P0001', { where: 'PL/pgSQL function other() line 1 at RAISE' }),
      databaseError('P0001'),
      databaseError('22P02'),
      databaseError('22023'),
      new Error('Connection terminated unexpectedly'),
      'not an error',
    ];
    for (const error of others) {
      for (const step of STEPS) expect(classifyDatabaseError(error, step)).toBe(error);
    }
  });

  it('SYS-R19 leaves an error that is already typed as it is', () => {
    const typed = new AccountLockTimeout({ cause: databaseError('55P03') });
    expect(classifyDatabaseError(typed, 'key-wait')).toBe(typed);
  });
});
