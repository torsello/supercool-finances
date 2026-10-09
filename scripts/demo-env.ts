// npm run demo-env, run by `make demo-env` in the tools service (DEP-R48): runs the seed, then
// prints the shell assignments of the Quickstart, so `eval "$(make demo-env)"` sets TOKEN,
// OPERATOR_TOKEN, A and B with nothing to copy by hand. It writes no file.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { issueToken } from '../src/modules/auth/index.js';
import { ConfigError, loadAuthConfig, type Environment } from '../src/platform/config/config.js';
import { DEMO_USERS, fetchHttp, runSeed, SEED_API_URL } from './seed.js';

interface Output {
  write(text: string): unknown;
}

/** Runs the seed, writing its JSON on `stdout`; 0 when it succeeded. */
export type DemoEnvSeed = (stdout: Output, stderr: Output) => Promise<number>;

export interface DemoEnvOptions {
  seed: DemoEnvSeed;
  env: Environment;
  /** Milliseconds since the epoch. */
  now: () => number;
  stdout: Output;
  stderr: Output;
}

const SeedOutputSchema = z.object({
  users: z.array(
    z.object({
      name: z.string(),
      accounts: z.array(z.object({ id: z.string(), currency: z.string() })),
    }),
  ),
});

class DemoEnvFailure extends Error {}

function demoUser(name: string): (typeof DEMO_USERS)[number] {
  const user = DEMO_USERS.find((candidate) => candidate.name === name);
  if (user === undefined) throw new DemoEnvFailure(`table 1.2 has no ${name}`);
  return user;
}

function eurAccountOf(seeded: z.infer<typeof SeedOutputSchema>, name: string): string {
  const account = seeded.users
    .find((user) => user.name === name)
    ?.accounts.find((candidate) => candidate.currency === 'EUR');
  if (account === undefined) throw new DemoEnvFailure(`the seed printed no EUR account of ${name}`);
  return account.id;
}

/**
 * Runs the seed with its output captured, then prints `TOKEN`, `OPERATOR_TOKEN`, `A` and `B`, each
 * in single quotes; on any failure it prints nothing on `stdout`, a reason on `stderr`, and
 * returns 1.
 */
export async function runDemoEnv(options: DemoEnvOptions): Promise<0 | 1> {
  const { seed, env, now, stdout, stderr } = options;
  let captured = '';
  const code = await seed(
    {
      write(text: string) {
        captured += text;
        return true;
      },
    },
    stderr,
  );
  try {
    if (code !== 0) throw new DemoEnvFailure('the seed failed');
    let seeded: z.infer<typeof SeedOutputSchema>;
    try {
      seeded = SeedOutputSchema.parse(JSON.parse(captured));
    } catch {
      throw new DemoEnvFailure('the seed printed no valid JSON');
    }
    const a = eurAccountOf(seeded, 'demo-customer-1');
    const b = eurAccountOf(seeded, 'demo-customer-2');
    const settings = loadAuthConfig(env);
    const tokenOf = async (name: string): Promise<string> => {
      const user = demoUser(name);
      return await issueToken({ userId: user.id, role: user.role }, settings, now() / 1000);
    };
    const assignments = {
      TOKEN: await tokenOf('demo-customer-1'),
      OPERATOR_TOKEN: await tokenOf('demo-operator'),
      A: a,
      B: b,
    };
    // Every value is a JWT or a UUID, so single quotes need no escaping.
    stdout.write(
      Object.entries(assignments)
        .map(([name, value]) => `${name}='${value}'\n`)
        .join(''),
    );
    return 0;
  } catch (error) {
    if (error instanceof DemoEnvFailure || error instanceof ConfigError) {
      stderr.write(`demo-env: ${error.message}\n`);
      return 1;
    }
    stderr.write(`demo-env: failed (${error instanceof Error ? error.name : 'unknown error'})\n`);
    return 1;
  }
}

// Runs only as the entry point, so the unit tests can import runDemoEnv.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDemoEnv({
    seed: async (stdout, stderr) =>
      await runSeed({
        http: fetchHttp(SEED_API_URL),
        clock: {
          now: () => Date.now(),
          sleep: async (ms) => {
            await new Promise((done) => setTimeout(done, ms));
          },
        },
        env: process.env,
        stdout,
        stderr,
      }),
    env: process.env,
    now: () => Date.now(),
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
