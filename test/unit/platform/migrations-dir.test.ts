import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { findMigrationsDir, shippedMigrations } from '../../../src/platform/db/migrations-dir.js';

const REPOSITORY = fileURLToPath(new URL('../../..', import.meta.url));

describe('the migrations folder', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** A temporary tree with `dirs` created and `files` written, under a fresh root. */
  function tree(dirs: string[], files: string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'scf-migrations-'));
    roots.push(root);
    for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true });
    for (const file of files) writeFileSync(join(root, file), '-- Up Migration\n');
    return root;
  }

  it('SEC-R24 finds the repository migrations/ from the source tree, with every shipped migration in order', () => {
    const dir = findMigrationsDir(join(REPOSITORY, 'src', 'platform', 'db'));
    expect(dir).toBe(join(REPOSITORY, 'migrations'));
    const names = shippedMigrations(dir);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('1791468174000_readiness-grant');
    expect(names.every((name) => !name.endsWith('.sql'))).toBe(true);
  });

  it('SEC-R24 finds dist/migrations/ from a build, the nearest ancestor that holds a migrations folder', () => {
    const root = tree(
      ['migrations', 'dist/migrations', 'dist/platform/db'],
      ['migrations/1_source.sql', 'dist/migrations/2_built.sql', 'dist/migrations/notes.txt'],
    );
    const dir = findMigrationsDir(join(root, 'dist', 'platform', 'db'));
    expect(dir).toBe(join(root, 'dist', 'migrations'));
    expect(shippedMigrations(dir)).toEqual(['2_built']);
  });

  it('SEC-R24 fails when no ancestor holds a migrations folder, or the folder holds no migration', () => {
    const none = tree(['dist/platform/db']);
    expect(() => findMigrationsDir(join(none, 'dist', 'platform', 'db'))).toThrow(
      /no migrations folder/,
    );
    const empty = tree(['dist/migrations', 'dist/platform/db'], ['dist/migrations/readme.txt']);
    expect(() => findMigrationsDir(join(empty, 'dist', 'platform', 'db'))).toThrow(
      /holds no migration/,
    );
  });
});
