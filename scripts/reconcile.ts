// npm run reconcile: the reconciliation of spec 002 against DATABASE_URL (LED-R21).
import { runReconcile } from '../src/modules/ledger/adapters/cli/reconcile.js';

process.exitCode = await runReconcile({
  databaseUrl: process.env['DATABASE_URL'],
  stdout: process.stdout,
  stderr: process.stderr,
});
