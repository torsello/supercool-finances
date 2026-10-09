import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { findMigrationsDir } from './migrations-dir.js';

export type MigrationDirection = 'up' | 'down';

export interface MigrateOptions {
  /** The owner role's URL: migrations never run as the runtime role (DEP-R05, ADR-0018). */
  databaseUrl: string;
  direction: MigrationDirection;
  /**
   * How many migrations to apply or roll back: every pending one going up and the last one going
   * down when not given, as node-pg-migrate's command line does.
   */
  count?: number;
  /** The migrations folder; the one the code ships when not given (`findMigrationsDir`). */
  dir?: string;
}

/**
 * Runs node-pg-migrate's programmatic runner over the SQL migrations and returns the names of the
 * migrations it applied or rolled back, in order; none when the database is already up to date
 * (DEP-R04). One code path for `npm run migrate:up`, the `migrate` service of `compose.yaml`, the
 * scratch databases of the tests and the AWS migration task (plan 008 section 1). The runner takes
 * an advisory lock without waiting for it, so a run started while another holds it fails at once
 * and applies nothing; it never waits for the other run. It also checks that the applied migrations
 * are a prefix of the shipped ones (`checkOrder`).
 */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const applied = await runner({
    databaseUrl: options.databaseUrl,
    dir: options.dir ?? findMigrationsDir(),
    migrationsTable: 'pgmigrations',
    direction: options.direction,
    ...(options.count === undefined ? {} : { count: options.count }),
    checkOrder: true,
    log: () => undefined,
  });
  return applied.map((migration) => migration.name);
}

interface Output {
  write(text: string): unknown;
}

export interface MigrateCommandOptions {
  /** The arguments after the script: `up` or `down`. */
  argv: readonly string[];
  /** `MIGRATION_DATABASE_URL`, the owner role's URL (DEP-R05). */
  databaseUrl: string | undefined;
  stdout: Output;
  stderr: Output;
  /** The migrations folder; tests point it at a copy with a failing migration. */
  dir?: string;
}

const USAGE = 'usage: migrate up|down';

/** The SQLSTATE and the server's message of a failed statement, also behind a wrapping error. */
function databaseErrorOf(error: unknown): pg.DatabaseError | undefined {
  // The server's message never holds the connection's credentials; a connection error is not a
  // DatabaseError, and its message may name the host.
  if (error instanceof pg.DatabaseError) return error;
  return error instanceof Error ? databaseErrorOf(error.cause) : undefined;
}

/**
 * node-pg-migrate's own failures the command explains with a fixed text that names the cause: its
 * messages hold no credential, but are mapped rather than printed, like every other message.
 */
const KNOWN_FAILURES: readonly { pattern: RegExp; text: string }[] = [
  {
    pattern: /^Another migration is already running\b/,
    text: 'another migration run holds the migration lock, so this run applied nothing; run it again once that one has ended',
  },
  {
    pattern:
      /^(Not run migration \S+ is preceding already run migration \S+|Definitions of migrations .* have been deleted\.)/,
    text: 'the order check failed: the migrations applied to the database are not a prefix of the shipped ones, so a migration is missing or out of order; nothing was applied',
  },
];

function knownFailureOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return KNOWN_FAILURES.find(({ pattern }) => pattern.test(error.message))?.text;
}

/**
 * The system error code of a failure that is not a database error, such as `ECONNREFUSED` or
 * `ENOTFOUND`, also behind a wrapping error: safe to print, unlike the message, which may name the
 * host.
 */
function systemCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  return systemCodeOf(error.cause);
}

/**
 * `node dist/cli/migrate.js up|down` and `npm run migrate:up` / `migrate:down` (DEP-R04, DEP-R05):
 * applies every pending migration, or rolls back the last one, as the owner role of
 * `MIGRATION_DATABASE_URL`; prints `{"direction": ..., "applied": [...]}` on one line and returns
 * 0, with an empty list when there was nothing to do, so the `migrate` service can run on every
 * `docker compose up`. On a failure it prints one line on stderr, with the SQLSTATE and the
 * server's message of a failed statement, or the system error code of any other failure, but never
 * the URL or a connection error's message, which can hold credentials or the host, and returns 1,
 * so `compose.yaml` starts no replica (DEP-R03).
 */
export async function runMigrateCommand(options: MigrateCommandOptions): Promise<0 | 1> {
  const { argv, stdout, stderr } = options;
  const direction = argv[0];
  if (argv.length !== 1 || (direction !== 'up' && direction !== 'down')) {
    stderr.write(`migrate: ${USAGE}\n`);
    return 1;
  }
  if (options.databaseUrl === undefined || options.databaseUrl === '') {
    stderr.write('migrate: MIGRATION_DATABASE_URL is not set\n');
    return 1;
  }
  try {
    const applied = await migrate({
      databaseUrl: options.databaseUrl,
      direction,
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    });
    stdout.write(`${JSON.stringify({ direction, applied })}\n`);
    return 0;
  } catch (error) {
    const known = knownFailureOf(error);
    if (known !== undefined) {
      stderr.write(`migrate: ${known}\n`);
      return 1;
    }
    const database = databaseErrorOf(error);
    const code = systemCodeOf(error);
    stderr.write(
      database === undefined
        ? `migrate: the migrations failed (${error instanceof Error ? error.name : 'unknown error'}${code === undefined ? '' : `, ${code}`})\n`
        : `migrate: the migrations failed with SQLSTATE ${database.code ?? 'unknown'}: ${database.message}\n`,
    );
    return 1;
  }
}
