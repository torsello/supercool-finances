import { buildApp, type RouteModule, type TestSeams } from '../../src/app.js';
import type { Environment } from '../../src/platform/config/config.js';
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
 * The seams `buildApp` has hook points for so far. The unit of work's faults and the reversal's
 * skipped check are attached once the composition root builds those components (the account,
 * movement and reversal routes), and the response and connection hooks once the presenter and the
 * keyed handler exist (the idempotency wiring), each in the 08-api step that builds it.
 */
function seams(): TestSeams {
  return { throwingRoute };
}

/** The test app: the composition root with the test seams attached and its logs captured. */
export function buildTestApp(options: { env?: Environment } = {}): BuiltApp {
  const logs = new LogCapture();
  const app = buildApp(testConfig(options.env), { logStream: logs.stream, seams: seams() });
  return { app, logs };
}
