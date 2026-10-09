import closeWithGrace from 'close-with-grace';
import { buildApp, createShutdown, listen } from './app.js';
import { loadConfig, type Config } from './platform/config/config.js';
import { writeStartupFailure } from './platform/logging/logger.js';

/** Time beyond the drain delay and the shutdown timeout before the process exits regardless. */
const SHUTDOWN_MARGIN_MS = 5000;

/** The signals that start the shutdown (SEC-R25). */
const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

/**
 * Every event `close-with-grace` would otherwise act on but uncaught errors: it exits at once on
 * a second signal, so the signals are handled here instead.
 */
const NOT_FOR_CLOSE_WITH_GRACE = [
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGILL',
  'SIGTRAP',
  'SIGABRT',
  'SIGBUS',
  'SIGFPE',
  'SIGSEGV',
  'SIGUSR2',
  'SIGTERM',
  'beforeExit',
] as const;

/** The shutdown ended with work cut off: the process exits 1 (SEC-R28). */
class WorkCutOff extends Error {
  override readonly name = 'WorkCutOff';
}

/**
 * The service's entry point. The configuration is validated before the app is built or anything
 * connects; an invalid one is written as one JSON line naming every invalid variable with its rule
 * and never a value, and the process exits with code 1 without listening (SEC-R39, SEC-R40); so is
 * a failure while building the app. The exit code is set rather than forced, so the line is
 * written whole before the process ends.
 *
 * Once listening, SIGTERM and SIGINT run the shutdown of section 1.8 of spec 007, which exits 0
 * when every request finished and 1 when work was cut off (SEC-R25 to SEC-R28); a further signal is
 * logged at `warn` and ignored, and the shutdown's own deadline bounds the exit. An uncaught
 * exception or unhandled rejection runs the same shutdown through `close-with-grace` and exits 1
 * (plan 007 section 4).
 */
async function main(): Promise<void> {
  let config: Config;
  let app: ReturnType<typeof buildApp>;
  try {
    config = loadConfig(process.env);
    app = buildApp(config);
  } catch (error) {
    writeStartupFailure(error);
    process.exitCode = 1;
    return;
  }
  const shutdown = createShutdown(app, config);
  const limitMs = config.shutdownDrainDelayMs + config.shutdownTimeoutMs + SHUTDOWN_MARGIN_MS;
  const runShutdown = (signal: NodeJS.Signals): void => {
    setTimeout(() => {
      app.log.error({ limitMs }, 'the shutdown did not end in time: exiting');
      process.exit(1);
    }, limitMs).unref();
    void shutdown.shutdown(signal).then((code) => process.exit(code));
  };
  // Installed before listening, so a signal that arrives during startup is never left to Node's
  // default action: it is held, and runs the shutdown once listening has finished.
  let started = false;
  let listening = false;
  let pending: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (started) {
      app.log.warn({ signal }, 'signal received during the shutdown: ignored');
      return;
    }
    started = true;
    if (listening) runShutdown(signal);
    else pending = signal;
  };
  for (const signal of SHUTDOWN_SIGNALS) process.on(signal, onSignal);

  try {
    await listen(app, config);
  } catch (error) {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, onSignal);
    // The app's logger keeps secrets out of the line (SEC-R22).
    app.log.fatal({ err: error }, 'startup failed');
    process.exitCode = 1;
    await app.close();
    return;
  }
  listening = true;
  if (pending !== undefined) runShutdown(pending);

  closeWithGrace(
    {
      delay: limitMs,
      skip: [...NOT_FOR_CLOSE_WITH_GRACE],
      logger: {
        error: (message: unknown) => {
          app.log.error({ err: message }, 'shutdown failed');
        },
      },
    },
    async ({ err }) => {
      // A signal from now on is ignored, so the exit stays 1.
      started = true;
      app.log.fatal({ err }, 'uncaught error: shutting down');
      const code = await shutdown.shutdown('uncaught error');
      if (code !== 0) throw new WorkCutOff('requests were still in flight at the shutdown timeout');
    },
  );
}

await main();
