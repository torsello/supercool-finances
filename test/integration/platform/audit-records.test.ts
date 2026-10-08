import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rejection, rollingBack } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

interface AuditRow {
  action: string;
  transaction_id?: string | null;
  reversed_transaction_id?: string | null;
  reason?: string | null;
  old_status?: string | null;
  new_status?: string | null;
}

const INSERT = `INSERT INTO audit_records
  (id, actor_id, actor_role, action, account_ids, transaction_id, reversed_transaction_id,
   reason, old_status, new_status, request_id)
  VALUES ($1, $2, 'operator', $3, ARRAY[$4::uuid], $5, $6, $7, $8, $9, 'req-test')`;

function values(row: AuditRow): unknown[] {
  return [
    randomUUID(),
    randomUUID(),
    row.action,
    randomUUID(),
    row.transaction_id ?? null,
    row.reversed_transaction_id ?? null,
    row.reason ?? null,
    row.old_status ?? null,
    row.new_status ?? null,
  ];
}

describe('audit records', () => {
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
  });

  /** A transaction row for the audit record to reference; rolled back with the test's transaction. */
  async function transaction(kind = 'deposit', reversed: string | null = null): Promise<string> {
    const id = randomUUID();
    await runtime.query(
      `INSERT INTO transactions (id, kind, currency, reversed_transaction_id) VALUES ($1, $2, 'EUR', $3)`,
      [id, kind, reversed],
    );
    return id;
  }

  it('SYS-R23 ACC-R26 scf_app inserts and reads audit records of movements, reversals and status changes', async () => {
    await rollingBack(runtime, async () => {
      const deposit = await transaction();
      const reversal = await transaction('reversal', deposit);
      const rows: AuditRow[] = [
        { action: 'deposit', transaction_id: deposit },
        {
          action: 'reversal',
          transaction_id: reversal,
          reversed_transaction_id: deposit,
          reason: 'Duplicate',
        },
        { action: 'freeze', old_status: 'active', new_status: 'frozen' },
      ];
      const ids: string[] = [];
      for (const row of rows) {
        const params = values(row);
        await runtime.query(INSERT, params);
        ids.push(params[0] as string);
      }

      const stored = await runtime.query<{ action: string; equal: boolean }>(
        `SELECT action, created_at <= clock_timestamp() AS equal FROM audit_records
         WHERE id = ANY($1::uuid[]) ORDER BY action`,
        [ids],
      );
      expect(stored.rows).toEqual([
        { action: 'deposit', equal: true },
        { action: 'freeze', equal: true },
        { action: 'reversal', equal: true },
      ]);
    });
  });

  it('SYS-R23 ACC-R26 scf_app cannot update, delete or truncate audit records', async () => {
    for (const statement of [
      `UPDATE audit_records SET reason = 'changed'`,
      'DELETE FROM audit_records',
      'TRUNCATE audit_records',
    ]) {
      const error = await rejection(runtime, statement);
      expect(error.code).toBe('42501');
    }
  });

  it('SYS-R23 ACC-R26 refuses a record whose nullable columns do not match its action', async () => {
    const mismatched: { name: string; row: (tx: string) => AuditRow }[] = [
      { name: 'movement without transaction', row: () => ({ action: 'transfer' }) },
      {
        name: 'movement with statuses',
        row: (tx) => ({
          action: 'withdrawal',
          transaction_id: tx,
          old_status: 'active',
          new_status: 'frozen',
        }),
      },
      {
        name: 'movement with a reason',
        row: (tx) => ({ action: 'deposit', transaction_id: tx, reason: 'x' }),
      },
      {
        name: 'movement with a reversed transaction',
        row: (tx) => ({ action: 'deposit', transaction_id: tx, reversed_transaction_id: tx }),
      },
      {
        name: 'reversal without link or reason',
        row: (tx) => ({ action: 'reversal', transaction_id: tx }),
      },
      {
        name: 'reversal without reason',
        row: (tx) => ({ action: 'reversal', transaction_id: tx, reversed_transaction_id: tx }),
      },
      { name: 'status change without statuses', row: () => ({ action: 'close' }) },
      {
        name: 'status change with a transaction',
        row: (tx) => ({
          action: 'unfreeze',
          transaction_id: tx,
          old_status: 'frozen',
          new_status: 'active',
        }),
      },
      { name: 'unknown action', row: (tx) => ({ action: 'refund', transaction_id: tx }) },
      {
        name: 'unknown status',
        row: () => ({ action: 'freeze', old_status: 'active', new_status: 'paused' }),
      },
    ];

    for (const { name, row } of mismatched) {
      const outcome = await rollingBack(runtime, async () => {
        const tx = await transaction();
        try {
          await runtime.query(INSERT, values(row(tx)));
          return 'stored';
        } catch (error) {
          return error instanceof pg.DatabaseError ? error.code : 'unexpected';
        }
      });
      expect({ name, outcome }).toEqual({ name, outcome: '23514' });
    }
  });
});
