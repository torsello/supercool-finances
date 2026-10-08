import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** The repository's migrations folder, the same one `npm run migrate:up` reads. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Names of the shipped migrations, in the order node-pg-migrate applies them. */
export function shippedMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => file.slice(0, -'.sql'.length))
    .sort();
}

/**
 * Runs node-pg-migrate's programmatic runner over the SQL migrations, with the same options as
 * `npm run migrate:up` and `migrate:down`. The URL must be the owner role's (ADR-0018, DEP-R05).
 * `count` 0 rolls every migration back when going down.
 */
export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down',
  count?: number,
): Promise<void> {
  await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction,
    ...(count === undefined ? {} : { count }),
    checkOrder: true,
    log: () => undefined,
  });
}
