import { fileURLToPath } from 'node:url';
import { migrate as runMigrations } from '../../src/platform/db/migrate.js';
import { shippedMigrations as migrationsIn } from '../../src/platform/db/migrations-dir.js';

/** The repository's migrations folder, the same one `npm run migrate:up` reads. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Names of the shipped migrations, in the order node-pg-migrate applies them. */
export function shippedMigrations(): string[] {
  return migrationsIn(MIGRATIONS_DIR);
}

/**
 * Runs the migrations through the service's own runner (`src/platform/db/migrate.ts`), the code
 * path of `npm run migrate:up`, the `migrate` service and the AWS migration task (plan 008
 * section 1). The URL must be the owner role's (ADR-0018, DEP-R05). `count` 0 rolls every migration
 * back when going down.
 */
export async function migrate(
  databaseUrl: string,
  direction: 'up' | 'down',
  count?: number,
): Promise<void> {
  await runMigrations({
    databaseUrl,
    direction,
    dir: MIGRATIONS_DIR,
    ...(count === undefined ? {} : { count }),
  });
}
