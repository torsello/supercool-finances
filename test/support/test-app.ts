import { buildApp, type RouteModule, type TestSeams } from '../../src/app.js';
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
  scope.get('/test/throw', { config: { roles: ['customer', 'operator'] } }, () => {
    throw new Error(THROWING_ROUTE_MESSAGE);
  });
};

/**
 * `unit-of-work-faults`: throws `error` when the work reaches `step`, until cleared. A test sets it
 * just before the request it faults and clears it afterwards.
 */
export class UnitOfWorkFaultSeam implements UnitOfWorkFaults {
  #fault: { step: FaultStep; error: Error } | undefined;

  failAt(step: FaultStep, error: Error): void {
    this.#fault = { step, error };
  }

  clear(): void {
    this.#fault = undefined;
  }

  atStep(step: FaultStep): void {
    if (this.#fault?.step === step) throw this.#fault.error;
  }
}

export interface BuiltTestApp extends BuiltApp {
  faults: UnitOfWorkFaultSeam;
}

/**
 * The seams `buildApp` has hook points for so far. The reversal's skipped check is attached once
 * the composition root builds the reversal use case (the reversal routes), and the response and
 * connection hooks once the presenter and the keyed handler exist (the idempotency wiring), each
 * in the 08-api step that builds it.
 */
function seams(faults: UnitOfWorkFaultSeam): TestSeams {
  return { unitOfWorkFaults: faults, throwingRoute };
}

/** The test app: the composition root with the test seams attached and its logs captured. */
export function buildTestApp(options: { env?: Environment } = {}): BuiltTestApp {
  const logs = new LogCapture();
  const faults = new UnitOfWorkFaultSeam();
  const app = buildApp(testConfig(options.env), { logStream: logs.stream, seams: seams(faults) });
  return { app, logs, faults };
}
