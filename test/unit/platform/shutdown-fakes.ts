import { ShutdownCoordinator, type WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import type { FakeClock } from '../../support/clock.js';

const quiet = { info: () => undefined, warn: () => undefined };

/** A coordinator over `tracker` whose readiness, server and closable resources record calls. */
export function coordinator(
  clock: FakeClock,
  tracker: WorkTracker,
  calls: string[],
  settings: { drainDelayMs: number; timeoutMs: number },
): ShutdownCoordinator {
  const closer = (name: string) => async () => {
    calls.push(`${name} closed`);
    await Promise.resolve();
  };
  return new ShutdownCoordinator({
    timers: clock,
    ...settings,
    work: tracker,
    readiness: { stop: () => calls.push('readiness 503') },
    server: {
      stopAccepting: () => calls.push('stopped accepting'),
      closeIdleConnections: () => calls.push('idle connections closed'),
    },
    resources: [
      ['pool', closer('pool')],
      ['readiness connection', closer('readiness connection')],
      ['redis', closer('redis')],
    ],
    logger: quiet,
  });
}

/** The exit code once the shutdown ended, or undefined while it runs. */
export function watch(shutdown: Promise<number>): { code: number | undefined } {
  const state: { code: number | undefined } = { code: undefined };
  void shutdown.then((code) => (state.code = code));
  return state;
}
