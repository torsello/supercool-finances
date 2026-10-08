import type { Kysely } from 'kysely';
import type { AccountStatus, Database } from '../db/schema.js';

interface AuditBase {
  actorId: string;
  actorRole: 'customer' | 'operator';
  /** The customer accounts involved, never a system account. */
  accountIds: readonly string[];
  /** The correlation id (SYS-R21). */
  requestId: string;
}

/** One audit record of plan 000 section 3; its fields depend on `action`. */
export type AuditRecordInput =
  | (AuditBase & { action: 'deposit' | 'withdrawal' | 'transfer'; transactionId: string })
  | (AuditBase & {
      action: 'reversal';
      transactionId: string;
      reversedTransactionId: string;
      /** Stored exactly as sent (REV-R15). */
      reason: string;
    })
  | (AuditBase & {
      action: 'freeze' | 'unfreeze' | 'close';
      oldStatus: AccountStatus;
      newStatus: AccountStatus;
    });

/**
 * Writes audit records (SYS-R23, ACC-R26) through the executor it is given, so a record joins the
 * transaction of the change it records. Each module declares the `AuditLog` port it needs.
 */
export class KyselyAuditLog {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ids: { next(): string },
  ) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.db
      .insertInto('audit_records')
      .values({
        id: this.ids.next(),
        actor_id: input.actorId,
        actor_role: input.actorRole,
        action: input.action,
        account_ids: input.accountIds.toSorted(),
        transaction_id: 'transactionId' in input ? input.transactionId : null,
        reversed_transaction_id: input.action === 'reversal' ? input.reversedTransactionId : null,
        reason: input.action === 'reversal' ? input.reason : null,
        old_status: 'oldStatus' in input ? input.oldStatus : null,
        new_status: 'newStatus' in input ? input.newStatus : null,
        request_id: input.requestId,
      })
      .execute();
  }
}
