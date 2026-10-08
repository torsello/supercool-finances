import { buildApp, listen } from './app.js';
import { loadConfig, type Config } from './platform/config/config.js';
import { writeStartupFailure } from './platform/logging/logger.js';

/**
 * The service's entry point. The configuration is validated before the app is built or anything
 * connects; an invalid one is written as one JSON line naming every invalid variable with its rule
 * and never a value, and the process exits with code 1 without listening (SEC-R39, SEC-R40). The
 * exit code is set rather than forced, so the line is written whole before the process ends.
 */
async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    writeStartupFailure(error);
    process.exitCode = 1;
    return;
  }
  const app = buildApp(config);
  try {
    await listen(app, config);
  } catch (error) {
    // The app's logger keeps secrets out of the line (SEC-R22).
    app.log.fatal({ err: error }, 'startup failed');
    process.exitCode = 1;
    await app.close();
  }
}

await main();
