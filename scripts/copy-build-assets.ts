import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildAssetsOptions {
  /** The repository root, which holds `migrations/` and `certs/`. */
  root: string;
  /** The build's output folder, `dist/` for `npm run build`. */
  outDir: string;
}

/**
 * The second step of `npm run build`: copies `migrations/*.sql` into `<outDir>/migrations/`, so the
 * production build ships the migrations readiness checks against (SEC-R24, plan 007 section 1),
 * and AWS's public RDS CA bundle into `<outDir>/certs/`, so the migration and bootstrap tasks
 * verify the RDS instance's certificate (DEP-R41, section 1.7 of spec 008). Each folder is emptied
 * first, so a file removed from the source never lingers in the build.
 */
export function copyBuildAssets({ root, outDir }: BuildAssetsOptions): void {
  const copies: { from: string; to: string; files: (name: string) => boolean }[] = [
    { from: 'migrations', to: 'migrations', files: (name) => name.endsWith('.sql') },
    { from: 'certs', to: 'certs', files: (name) => name === 'rds-global-bundle.pem' },
  ];
  for (const { from, to, files } of copies) {
    const source = join(root, from);
    const target = join(outDir, to);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(source).filter(files)) {
      copyFileSync(join(source, name), join(target, name));
    }
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  copyBuildAssets({ root: process.cwd(), outDir: 'dist' });
}
