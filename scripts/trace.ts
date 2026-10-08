// Command line of the traceability gate. It always runs the check: there is no entry-point test
// to get wrong, so a failing check can never exit 0 by skipping it.
import { run } from './traceability.js';

process.exitCode = run(process.argv.slice(2), process.cwd());
