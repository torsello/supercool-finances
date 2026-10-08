import { NotFound } from '../../accounts/index.js';
import {
  AlreadyReversed,
  reversalOf,
  type AlreadyReversedCause,
  type AppendedTransaction,
  type LedgerTransaction,
} from '../../ledger/index.js';
import { checkReversal } from '../domain/reversal-rules.js';
import type { MovementSettings, MovementTransaction } from './ports.js';
import type { ReversalResult } from './results.js';
import { lockAccounts, parseUuid } from './steps.js';

export interface ReverseCommand {
  /** The id from the path, not yet parsed. */
  transactionId: string;
  /** Validated at the HTTP edge (REV-R14); stored exactly as sent, in the audit record only. */
  reason: string;
  actor: { id: string; role: 'operator' };
  requestId: string;
}

/**
 * The hook point of the `skip-existing-reversal-check` test seam (plan 000 section 8). Only the
 * test app passes it; the production composition root never does.
 */
export interface SkipExistingReversalCheck {
  /** Called in place of step 5 of section 1.4 of spec 004, which is then skipped. */
  skipped(originalId: string): void;
  /** Called with the `cause` of the `AlreadyReversed` the ledger writer threw for the insert. */
  insertRefused(cause: AlreadyReversedCause | undefined): void;
}

/** The test seam this component attaches, as plan 000 section 8 names it. */
export type ReversalTestHook = 'skip-existing-reversal-check';

export interface ReversalsOptions {
  skipExistingReversalCheck?: SkipExistingReversalCheck;
}

async function append(
  tx: MovementTransaction,
  reversal: LedgerTransaction,
  hook: SkipExistingReversalCheck | undefined,
): Promise<AppendedTransaction> {
  try {
    return await tx.ledger.append(reversal);
  } catch (error) {
    if (hook !== undefined && error instanceof AlreadyReversed) hook.insertRefused(error.cause);
    throw error;
  }
}

/**
 * The reversal use case, built once by the composition root. Its only option is the hook point of
 * the `skip-existing-reversal-check` seam, which the production composition root never passes;
 * `attachedTestHooks()` names the seams attached, so SYS-AC24 can assert there are none.
 */
export class Reversals {
  readonly #skipExistingReversalCheck: SkipExistingReversalCheck | undefined;

  constructor(options: ReversalsOptions = {}) {
    this.#skipExistingReversalCheck = options.skipExistingReversalCheck;
  }

  attachedTestHooks(): ReversalTestHook[] {
    return this.#skipExistingReversalCheck === undefined ? [] : ['skip-existing-reversal-check'];
  }

  /**
   * Steps 6 to 8 of a reversal (plan 004 section 3) on the unit of work it is given: the lookup
   * of the original and its kind, the locks of the original's customer accounts in ascending
   * order, steps 5 to 8 of section 1.4 of spec 004 on the rows read under them, then the ledger
   * and the audit record. `MAX_AMOUNT_MINOR` is never read (REV-R12).
   */
  async reverse(
    tx: MovementTransaction,
    settings: MovementSettings,
    command: ReverseCommand,
  ): Promise<ReversalResult> {
    const id = parseUuid(command.transactionId);
    if (id === undefined) throw new NotFound();
    const original = await tx.transactions.findTransaction(id);
    if (original === undefined) throw new NotFound();
    // Throws TransactionNotReversible for a reversal, before any lock (REV-R07).
    const reversal = reversalOf(original);

    const locked = await lockAccounts(
      tx,
      settings,
      original.entries.map((entry) => ({ id: entry.accountId, kind: entry.accountKind })),
    );
    const hook = this.#skipExistingReversalCheck;
    let alreadyReversed = false;
    if (hook === undefined) {
      alreadyReversed = (await tx.transactions.findReversalOf(id)) !== undefined;
    } else {
      hook.skipped(id);
    }
    checkReversal(reversal, { alreadyReversed, accounts: locked });

    const appended = await append(tx, reversal, hook);
    await tx.audit.record({
      actorId: command.actor.id,
      actorRole: command.actor.role,
      action: 'reversal',
      accountIds: [...locked.keys()],
      transactionId: appended.transactionId,
      reversedTransactionId: id,
      reason: command.reason,
      requestId: command.requestId,
    });
    return {
      transactionId: appended.transactionId,
      kind: 'reversal',
      amount: original.entries.reduce(
        (sum, entry) => (entry.amount > 0n ? sum + entry.amount : sum),
        0n,
      ),
      currency: original.currency,
      createdAt: appended.createdAt,
      reversedTransactionId: id,
    };
  }
}
