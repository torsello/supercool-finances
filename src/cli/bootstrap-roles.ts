// node dist/cli/bootstrap-roles.js: the one-time bootstrap of an AWS database, as the RDS master
// user (DEP-R38, DEP-R39). Run by the bootstrap task before the first migration task (DEP-R40).
import { runBootstrapCommand } from '../platform/db/bootstrap-roles.js';

process.exitCode = await runBootstrapCommand({
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
