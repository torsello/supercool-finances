// npm run token -- --sub <id> --role <role>: mints a token for local use and demos (section 1.2 of
// spec 006). It never runs inside the service.
import { main } from '../src/modules/auth/adapters/cli/token.js';

process.exitCode = await main(process.argv.slice(2), process.env, process.stdout, process.stderr);
