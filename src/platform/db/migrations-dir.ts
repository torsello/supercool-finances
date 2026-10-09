import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The folder of the migrations, by its name, from the source tree and from the build alike. */
const FOLDER = 'migrations';
const EXTENSION = '.sql';

function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/**
 * The migrations the code ships (SEC-R24): starting from `from`, the first ancestor that holds a
 * `migrations/` folder. From the source tree (`src/platform/db/`) that is the repository's
 * `migrations/`; from the build (`dist/platform/db/`) it is `dist/migrations/`, which
 * `npm run build` fills. It fails when no folder or no migration is found, so readiness is never
 * checked against an empty list.
 */
export function findMigrationsDir(from: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, FOLDER);
    if (isDirectory(candidate)) {
      if (shippedMigrations(candidate).length === 0) {
        throw new Error(`the migrations folder ${candidate} holds no migration`);
      }
      return candidate;
    }
    if (dirname(dir) === dir) throw new Error(`no migrations folder above ${from}`);
  }
}

/**
 * The names of the migrations in `dir`, as node-pg-migrate records them in `pgmigrations`: each
 * `.sql` file's name without the extension, in the order they are applied.
 */
export function shippedMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(EXTENSION))
    .map((file) => file.slice(0, -EXTENSION.length))
    .sort();
}
