// npm run idempotency:cleanup: deletes expired idempotency keys against DATABASE_URL (IDM-R22).
// Compiled to dist/cli/idempotency-cleanup.js, which the scheduled cleanup task runs (DEP-R37).
import { runCleanup } from '../modules/idempotency/adapters/cli/cleanup.js';

process.exitCode = await runCleanup({
  databaseUrl: process.env['DATABASE_URL'],
  stdout: process.stdout,
  stderr: process.stderr,
});
