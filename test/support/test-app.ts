import type { Socket } from 'node:net';
import { buildApp, type RouteModule, type TestSeams } from '../../src/app.js';
import type {
  AfterCommitHook,
  ResponseBodyHook,
} from '../../src/modules/idempotency/adapters/http/keyed-handler.js';
import type { AlreadyReversedCause } from '../../src/modules/ledger/index.js';
import type { SkipExistingReversalCheck } from '../../src/modules/movements/index.js';
import type { Environment } from '../../src/platform/config/config.js';
import type { FaultStep, UnitOfWorkFaults } from '../../src/platform/db/unit-of-work.js';
import { testConfig, type BuiltApp } from './app.js';
import { LogCapture } from './logs.js';

/**
 * The one list of test seams (SYS-R37, plan 000 section 8). Only the test app attaches them; the
 * production app built by the composition root never does (SYS-AC24).
 */
export const TEST_SEAMS = [
  'unit-of-work-faults',
  'throwing-route',
  'skip-existing-reversal-check',
  'extra-response-member',
  'destroy-connection-after-commit',
] as const;

export type TestSeamName = (typeof TEST_SEAMS)[number];

/** The message of the throwing route's error, which no response may contain (SYS-AC20). */
export const THROWING_ROUTE_MESSAGE = 'boom at pg pool';

/** The path of the throwing route. */
export const THROWING_ROUTE_PATH = '/v1/test/throw';

/** `throwing-route`: `GET /v1/test/throw`, open to both roles, throws a plain error. */
const throwingRoute: RouteModule = (scope) => {
  // Hidden from the OpenAPI document: it is a test seam, not part of the API.
  scope.get(
    '/test/throw',
    { schema: { hide: true }, config: { roles: ['customer', 'operator'] } },
    () => {
      throw new Error(THROWING_ROUTE_MESSAGE);
    },
  );
};

/**
 * `unit-of-work-faults`: throws `error` when the work reaches `step`, or writes the ledger entry of
 * one account with another amount, until cleared. A test sets it just before the request it faults
 * and clears it afterwards.
 */
export class UnitOfWorkFaultSeam implements UnitOfWorkFaults {
  #fault: { step: FaultStep; error: Error } | undefined;
  #rewrite: { accountId: string; amount: bigint } | undefined;

  failAt(step: FaultStep, error: Error): void {
    this.#fault = { step, error };
  }

  /** Writes the entry on `accountId` as `amount` instead of its own amount (LED-AC23). */
  rewriteEntry(accountId: string, amount: bigint): void {
    this.#rewrite = { accountId, amount };
  }

  clear(): void {
    this.#fault = undefined;
    this.#rewrite = undefined;
  }

  atStep(step: FaultStep): void {
    if (this.#fault?.step === step) throw this.#fault.error;
  }

  entryAmount(entry: { accountId: string; amount: bigint }): bigint {
    return this.#rewrite?.accountId === entry.accountId ? this.#rewrite.amount : entry.amount;
  }
}

/**
 * `extra-response-member`: adds `name` with `value` to every new response body of a keyed request,
 * never to a replay, until cleared (IDM-AC08).
 */
export class ExtraResponseMemberSeam implements ResponseBodyHook {
  #member: { name: string; value: unknown } | undefined;

  add(name: string, value: unknown): void {
    this.#member = { name, value };
  }

  clear(): void {
    this.#member = undefined;
  }

  extend(body: Record<string, unknown>): Record<string, unknown> {
    return this.#member === undefined ? body : { ...body, [this.#member.name]: this.#member.value };
  }
}

/**
 * `destroy-connection-after-commit`: while enabled, destroys the client connection once a keyed
 * request's database transaction committed, before its response is written (IDM-AC21).
 */
export class DestroyConnectionSeam implements AfterCommitHook {
  #enabled = false;

  enable(): void {
    this.#enabled = true;
  }

  disable(): void {
    this.#enabled = false;
  }

  afterCommit(socket: Socket): void {
    if (this.#enabled) socket.destroy();
  }
}

/**
 * `skip-existing-reversal-check`: while enabled, skips step 5 of section 1.4 of spec 004 and
 * records each skipped reversal and the `cause` of the refused insert that follows (REV-AC08,
 * IDM-AC17).
 */
export class SkipExistingReversalCheckSeam implements SkipExistingReversalCheck {
  #enabled = false;
  readonly skipped: string[] = [];
  readonly refused: (AlreadyReversedCause | undefined)[] = [];

  enable(): void {
    this.#enabled = true;
  }

  disable(): void {
    this.#enabled = false;
  }

  skips(originalId: string): boolean {
    if (this.#enabled) this.skipped.push(originalId);
    return this.#enabled;
  }

  insertRefused(cause: AlreadyReversedCause | undefined): void {
    this.refused.push(cause);
  }
}

export interface BuiltTestApp extends BuiltApp {
  faults: UnitOfWorkFaultSeam;
  responseBody: ExtraResponseMemberSeam;
  connection: DestroyConnectionSeam;
  reversalCheck: SkipExistingReversalCheckSeam;
}

/** The hook points of `buildApp`, each set to its seam; the throwing route is a route of its own. */
function seams(seam: Omit<BuiltTestApp, keyof BuiltApp>): TestSeams {
  return {
    unitOfWorkFaults: seam.faults,
    throwingRoute,
    responseBody: seam.responseBody,
    afterCommit: seam.connection,
    skipExistingReversalCheck: seam.reversalCheck,
  };
}

/** The test app: the composition root with the test seams attached and its logs captured. */
export function buildTestApp(options: { env?: Environment } = {}): BuiltTestApp {
  const logs = new LogCapture();
  const seam = {
    faults: new UnitOfWorkFaultSeam(),
    responseBody: new ExtraResponseMemberSeam(),
    connection: new DestroyConnectionSeam(),
    reversalCheck: new SkipExistingReversalCheckSeam(),
  };
  const app = buildApp(testConfig(options.env), { logStream: logs.stream, seams: seams(seam) });
  return { app, logs, ...seam };
}
