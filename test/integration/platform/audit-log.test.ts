import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KyselyAuditLog } from '../../../src/platform/audit/kysely-audit-log.js';
import { UnitOfWork } from '../../../src/platform/db/unit-of-work.js';
import { rollingBack } from '../../support/db.js';
import { requireEnv } from '../../support/env.js';

interface StoredAudit {
  id: string;
  actor_id: string;
  actor_role: string;
  action: string;
  account_ids: string[];
  transaction_id: string | null;
  reversed_transaction_id: string | null;
  reason: string | null;
  old_status: string | null;
  new_status: string | null;
  request_id: string;
  created_at_set: boolean;
}

/** Ids handed out in order, so the test knows the id of the record it writes. */
function fixedIds(...ids: string[]): { next(): string } {
  return {
    next() {
      const id = ids.shift();
      if (id === undefined) throw new Error('fixedIds ran out of ids');
      return id;
    },
  };
}

describe('audit log adapter', () => {
  let runtime: pg.Client;

  beforeAll(async () => {
    runtime = new pg.Client({ connectionString: requireEnv('TEST_DATABASE_URL') });
    await runtime.connect();
  });

  afterAll(async () => {
    await runtime.end();
  });

  async function stored(actorId: string): Promise<StoredAudit[]> {
    const result = await runtime.query<StoredAudit>(
      `SELECT id, actor_id, actor_role, action, account_ids::text[] AS account_ids, transaction_id,
              reversed_transaction_id, reason, old_status, new_status, request_id,
              created_at IS NOT NULL AS created_at_set
       FROM audit_records WHERE actor_id = $1`,
      [actorId],
    );
    return result.rows;
  }

  async function insertTransaction(kind: string, reversed: string | null = null): Promise<string> {
    const id = randomUUID();
    await runtime.query(
      'INSERT INTO transactions (id, kind, currency, reversed_transaction_id) VALUES ($1, $2, $3, $4)',
      [id, kind, 'EUR', reversed],
    );
    return id;
  }

  it('SYS-R23 ACC-R26 writes one status-change record with the operator, role, account, old and new status and correlation id', async () => {
    await rollingBack(runtime, async () => {
      const recordId = randomUUID();
      const actorId = randomUUID();
      const accountId = randomUUID();
      const audit = new KyselyAuditLog(new UnitOfWork(runtime).db, fixedIds(recordId));
      await audit.record({
        actorId,
        actorRole: 'operator',
        action: 'freeze',
        accountIds: [accountId],
        oldStatus: 'active',
        newStatus: 'frozen',
        requestId: 'req-7',
      });
      expect(await stored(actorId)).toEqual([
        {
          id: recordId,
          actor_id: actorId,
          actor_role: 'operator',
          action: 'freeze',
          account_ids: [accountId],
          transaction_id: null,
          reversed_transaction_id: null,
          reason: null,
          old_status: 'active',
          new_status: 'frozen',
          request_id: 'req-7',
          created_at_set: true,
        },
      ]);
    });
  });

  it('SYS-R23 writes one movement record with the transaction id and the customer accounts in ascending order', async () => {
    await rollingBack(runtime, async () => {
      const recordId = randomUUID();
      const actorId = randomUUID();
      const accounts = [randomUUID(), randomUUID(), randomUUID()];
      const transactionId = await insertTransaction('transfer');
      const audit = new KyselyAuditLog(new UnitOfWork(runtime).db, fixedIds(recordId));
      await audit.record({
        actorId,
        actorRole: 'customer',
        action: 'transfer',
        accountIds: accounts,
        transactionId,
        requestId: 'req-mov',
      });
      expect(await stored(actorId)).toEqual([
        expect.objectContaining({
          id: recordId,
          actor_role: 'customer',
          action: 'transfer',
          account_ids: accounts.toSorted(),
          transaction_id: transactionId,
          reversed_transaction_id: null,
          reason: null,
          old_status: null,
          new_status: null,
          request_id: 'req-mov',
        }),
      ]);
    });
  });

  it('SYS-R23 writes one reversal record with the reversed transaction and the reason exactly as sent', async () => {
    await rollingBack(runtime, async () => {
      const actorId = randomUUID();
      const accountId = randomUUID();
      const original = await insertTransaction('deposit');
      const reversal = await insertTransaction('reversal', original);
      const audit = new KyselyAuditLog(new UnitOfWork(runtime).db, fixedIds(randomUUID()));
      await audit.record({
        actorId,
        actorRole: 'operator',
        action: 'reversal',
        accountIds: [accountId],
        transactionId: reversal,
        reversedTransactionId: original,
        reason: '  Duplicate deposit ñ  ',
        requestId: 'req-rev',
      });
      expect(await stored(actorId)).toEqual([
        expect.objectContaining({
          action: 'reversal',
          account_ids: [accountId],
          transaction_id: reversal,
          reversed_transaction_id: original,
          reason: '  Duplicate deposit ñ  ',
          old_status: null,
          new_status: null,
        }),
      ]);
    });
  });
});
