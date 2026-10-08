import { parseArgs } from 'node:util';
import {
  ConfigError,
  loadAuthConfig,
  type Environment,
} from '../../../../platform/config/config.js';
import { issueToken } from '../../application/token-issuer.js';
import { isRole } from '../../domain/caller.js';

interface Output {
  write(text: string): unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = 'usage: npm run token -- --sub <uuid> --role <customer|operator>';

/** A refusal whose message names the argument or variable at fault, never a value. */
class Refused extends Error {}

function parse(argv: readonly string[]): { sub: string; role: 'customer' | 'operator' } {
  let values: { sub?: string; role?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { sub: { type: 'string' }, role: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    // parseArgs names the unknown or incomplete option, such as --ttl, and no value.
    throw new Refused(error instanceof Error ? error.message : 'invalid arguments');
  }
  const { sub, role } = values;
  if (sub === undefined) throw new Refused('--sub is required');
  if (!UUID.test(sub)) throw new Refused('--sub must be a UUID');
  if (role === undefined) throw new Refused('--role is required');
  if (!isRole(role)) throw new Refused('--role must be customer or operator');
  return { sub, role };
}

/**
 * `npm run token -- --sub <id> --role <role>` (section 1.2 of spec 006): prints one token signed
 * with the configuration of `env` and returns 0; on a bad argument or configuration prints nothing
 * on stdout, one message naming the fault on stderr, never a value of `JWT_SECRET`, and returns 1
 * (AUT-R16, AUT-R17, AUT-R19). `clock` is in milliseconds since the epoch.
 */
export async function main(
  argv: readonly string[],
  env: Environment,
  stdout: Output,
  stderr: Output,
  clock: () => number = Date.now,
): Promise<number> {
  try {
    const { sub, role } = parse(argv);
    const settings = loadAuthConfig(env);
    const token = await issueToken({ userId: sub, role }, settings, clock() / 1000);
    stdout.write(`${token}\n`);
    return 0;
  } catch (error) {
    if (error instanceof Refused) {
      stderr.write(`token: ${error.message}\n${USAGE}\n`);
      return 1;
    }
    if (error instanceof ConfigError) {
      stderr.write(`token: ${error.message}\n`);
      return 1;
    }
    stderr.write('token: the token could not be signed\n');
    return 1;
  }
}
