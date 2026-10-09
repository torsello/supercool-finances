import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/deployment.js';
import { runOk, type CommandResult } from './support/command.js';
import { E2E_TMP } from './support/paths.js';
import { assertStackCanStart, compose, containerOf, downStack, PROJECT } from './support/stack.js';

/** The name of the migration that fails, sorted after every real one. */
const FAILING = '9999999999999_e2e-fails.sql';

describe('a failed migration', () => {
  const directory = join(E2E_TMP, 'failed-migration');
  const override = join(directory, 'compose.override.yaml');
  const files = ['compose.yaml', override];
  let up: CommandResult;

  beforeAll(async () => {
    await downStack();
    await assertStackCanStart();
    // The migrations the image ships plus one whose SQL fails, mounted over the image's folder by
    // an override file that only this AC uses.
    const migrations = join(directory, 'migrations');
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(migrations, { recursive: true });
    for (const name of readdirSync(join(REPOSITORY_ROOT, 'migrations'))) {
      if (name.endsWith('.sql'))
        copyFileSync(join(REPOSITORY_ROOT, 'migrations', name), join(migrations, name));
    }
    writeFileSync(
      join(migrations, FAILING),
      '-- Up Migration\n\nSELECT 1 / 0;\n\n-- Down Migration\n',
    );
    writeFileSync(
      override,
      [
        'services:',
        '  migrate:',
        '    volumes:',
        `      - ${JSON.stringify(`${migrations}:/app/dist/migrations:ro`)}`,
        '',
      ].join('\n'),
    );
    up = await compose(['up', '--build', '--wait'], { files });
  });

  afterAll(async () => {
    await downStack({ files });
    rmSync(directory, { recursive: true, force: true });
  });

  it('DEP-AC03 keeps the replicas and nginx down, and docker compose up fails', async () => {
    expect(up.code).not.toBe(0);

    const migrate = await containerOf('migrate');
    expect(migrate.State.Status).toBe('exited');
    expect(migrate.State.ExitCode).not.toBe(0);
    // It failed on the added migration, not on anything else.
    const logs = await runOk('docker', ['logs', migrate.Id]);
    expect(`${logs.stdout}${logs.stderr}`).toMatch(/SQLSTATE 22012: division by zero/);

    for (const service of ['api-1', 'api-2', 'nginx']) {
      const listed = await compose(['ps', '--all', '--quiet', service], { files });
      const ids = listed.stdout.split('\n').filter((id) => id !== '');
      if (ids.length === 0) continue;
      const [container] = JSON.parse((await runOk('docker', ['inspect', ...ids])).stdout) as {
        State: { Status: string; StartedAt: string };
      }[];
      // Created at most, never started: Docker's zero time is its start time.
      expect(container?.State.Status, `${PROJECT} ${service}`).toBe('created');
      expect(container?.State.StartedAt, service).toBe('0001-01-01T00:00:00Z');
    }
  });
});
