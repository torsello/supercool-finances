import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecret, syncEnv } from '../../scripts/env-sync.js';

const EXAMPLE = [
  '# comment',
  'NODE_ENV=development',
  '',
  'DATABASE_URL=postgres://user:pass@localhost:5432/db?sslmode=disable',
  'JWT_SECRET=change-me',
  'REDIS_PASSWORD=change-me',
  'API_KEY=change-me',
  'ADMIN_TOKEN=change-me',
  '',
].join('\n');

describe('env:sync', () => {
  let dir: string;
  let examplePath: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'env-sync-'));
    examplePath = join(dir, '.env.example');
    envPath = join(dir, '.env');
    writeFileSync(examplePath, EXAMPLE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .env from the example, with random values for secret-like keys', () => {
    const result = syncEnv(examplePath, envPath, () => 'generated');

    expect(result).toEqual({
      created: true,
      added: ['NODE_ENV', 'DATABASE_URL', 'JWT_SECRET', 'REDIS_PASSWORD', 'API_KEY', 'ADMIN_TOKEN'],
      placeholders: [],
    });
    expect(readFileSync(envPath, 'utf8')).toBe(
      [
        'NODE_ENV=development',
        'DATABASE_URL=postgres://user:pass@localhost:5432/db?sslmode=disable',
        'JWT_SECRET=generated',
        'REDIS_PASSWORD=generated',
        'API_KEY=generated',
        'ADMIN_TOKEN=generated',
        '',
      ].join('\n'),
    );
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('appends only missing keys and never changes existing ones', () => {
    writeFileSync(
      envPath,
      'NODE_ENV=production\nJWT_SECRET=keep-me\nREDIS_PASSWORD=keep\nAPI_KEY=keep\nADMIN_TOKEN=keep',
      { mode: 0o644 },
    );

    const result = syncEnv(examplePath, envPath, () => 'generated');

    expect(result).toEqual({ created: false, added: ['DATABASE_URL'], placeholders: [] });
    expect(readFileSync(envPath, 'utf8')).toBe(
      'NODE_ENV=production\nJWT_SECRET=keep-me\nREDIS_PASSWORD=keep\nAPI_KEY=keep\nADMIN_TOKEN=keep\n' +
        'DATABASE_URL=postgres://user:pass@localhost:5432/db?sslmode=disable\n',
    );
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('is a no-op when .env already has every key', () => {
    syncEnv(examplePath, envPath);
    const before = readFileSync(envPath, 'utf8');

    expect(syncEnv(examplePath, envPath)).toEqual({ created: false, added: [], placeholders: [] });
    expect(readFileSync(envPath, 'utf8')).toBe(before);
  });

  it('reports secret-like keys that still hold the example value, by name only', () => {
    writeFileSync(
      envPath,
      'NODE_ENV=development\nJWT_SECRET=change-me\nREDIS_PASSWORD= change-me \nAPI_KEY=real\n',
    );

    const result = syncEnv(examplePath, envPath, () => 'generated');

    expect(result.placeholders).toEqual(['JWT_SECRET', 'REDIS_PASSWORD']);
    expect(result.added).toEqual(['DATABASE_URL', 'ADMIN_TOKEN']);
  });

  it('ignores commented-out keys in .env', () => {
    writeFileSync(envPath, '# JWT_SECRET=old\n');

    expect(syncEnv(examplePath, envPath, () => 'generated').added).toContain('JWT_SECRET');
  });

  it('generates 48 random bytes, base64-encoded', () => {
    const first = generateSecret();

    expect(Buffer.from(first, 'base64')).toHaveLength(48);
    expect(generateSecret()).not.toBe(first);
  });
});
