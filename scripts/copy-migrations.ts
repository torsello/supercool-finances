import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The second step of `npm run build`: copies `migrations/*.sql` into `dist/migrations/`, so the
 * production build ships the migrations readiness checks against (SEC-R24, plan 007 section 1).
 * The folder is emptied first, so a migration removed from the source never lingers in the build.
 */
const SOURCE = 'migrations';
const TARGET = join('dist', 'migrations');

rmSync(TARGET, { recursive: true, force: true });
mkdirSync(TARGET, { recursive: true });
for (const file of readdirSync(SOURCE).filter((name) => name.endsWith('.sql'))) {
  copyFileSync(join(SOURCE, file), join(TARGET, file));
}
