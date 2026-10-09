// node dist/cli/migrate.js up|down: the migrations against MIGRATION_DATABASE_URL, as the owner
// role (DEP-R04, DEP-R05). Run by npm run migrate:up and migrate:down, the migrate service of
// compose.yaml and the AWS migration task (DEP-R28).
import { runMigrateCommand } from '../platform/db/migrate.js';

process.exitCode = await runMigrateCommand({
  argv: process.argv.slice(2),
  databaseUrl: process.env['MIGRATION_DATABASE_URL'],
  stdout: process.stdout,
  stderr: process.stderr,
});
