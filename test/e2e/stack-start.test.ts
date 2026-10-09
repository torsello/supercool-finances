import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT } from '../support/deployment.js';
import { describeResult, run, runOk, type CommandResult } from './support/command.js';
import { send } from './support/http.js';
import { E2E_TMP } from './support/paths.js';
import {
  assertStackCanStart,
  composeEnvironment,
  composeOk,
  downStack,
  LONG_RUNNING,
  OBSERVABILITY,
  PROJECT,
  projectContainers,
  serviceOf,
  serviceStates,
} from './support/stack.js';
import { nanos, StartupTimeline } from './support/timeline.js';

/**
 * A fresh clone of the commit at HEAD (plan 008 section 5). Uncommitted changes are not part of
 * what DEP-AC01 tests, so a warning names them.
 */
async function cloneHead(): Promise<string> {
  const status = await runOk('git', ['status', '--porcelain'], { cwd: REPOSITORY_ROOT });
  if (status.stdout.trim() !== '') {
    console.warn(
      `DEP-AC01 runs from a clone of HEAD: these uncommitted changes of the working tree are not part of what it tests:\n${status.stdout}`,
    );
  }
  const head = (await runOk('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT })).stdout.trim();
  mkdirSync(E2E_TMP, { recursive: true });
  const directory = join(E2E_TMP, `clone-${randomUUID()}`);
  await runOk('git', ['clone', '--quiet', REPOSITORY_ROOT, directory]);
  await runOk('git', ['checkout', '--quiet', '--detach', head], { cwd: directory });
  return directory;
}

async function projectImagesAndVolumes(): Promise<string[]> {
  const filter = `label=com.docker.compose.project=${PROJECT}`;
  const images = await runOk('docker', ['image', 'ls', '--quiet', '--filter', filter]);
  const named = await runOk('docker', [
    'image',
    'ls',
    '--quiet',
    '--filter',
    `reference=${PROJECT}-*`,
  ]);
  const volumes = await runOk('docker', ['volume', 'ls', '--quiet', '--filter', filter]);
  return [images.stdout, named.stdout, volumes.stdout].flatMap((text) =>
    text.split('\n').filter((line) => line !== ''),
  );
}

describe('the stack starts from a fresh clone', () => {
  let clone = '';
  let up: CommandResult;
  const timeline = new StartupTimeline();

  beforeAll(async () => {
    // No Docker image or volume of the project, so the build and the volumes start from nothing.
    await downStack({ images: true });
    expect(await projectImagesAndVolumes()).toEqual([]);
    await assertStackCanStart();
    clone = await cloneHead();
    timeline.start();
    try {
      // Exactly the command of DEP-R01, in the clone: no `node` or `npm` runs on the host.
      up = await run('docker', ['compose', 'up', '--build', '--wait'], {
        cwd: clone,
        env: composeEnvironment(),
        timeoutMs: 900_000,
      });
    } finally {
      await timeline.stop();
    }
  });

  afterAll(async () => {
    if (clone === '') return;
    await downStack({ cwd: clone });
    rmSync(clone, { recursive: true, force: true });
  });

  it('DEP-AC01 one command starts the stack from a fresh clone, without .env, publishing only 127.0.0.1 ports', async () => {
    expect(existsSync(join(clone, '.env'))).toBe(false);
    expect(existsSync(join(clone, 'node_modules'))).toBe(false);
    expect(up.code, describeResult('docker compose', ['up', '--build', '--wait'], up)).toBe(0);

    const states = await serviceStates({ cwd: clone });
    for (const service of LONG_RUNNING) {
      expect(
        states.find((state) => state.Service === service),
        service,
      ).toMatchObject({
        State: 'running',
        Health: 'healthy',
      });
    }
    expect(states.find((state) => state.Service === 'migrate')).toMatchObject({
      State: 'exited',
      ExitCode: 0,
    });
    expect(states.some((state) => state.Service === 'tools')).toBe(false);
    // The observability profile is never started by `up` (DEP-R42).
    const started = (await projectContainers()).map(serviceOf);
    for (const service of OBSERVABILITY) expect(started, service).not.toContain(service);

    const ready = await send({ url: '/health/ready' });
    expect(ready.status).toBe(200);

    const config = JSON.parse(
      (await composeOk(['config', '--format', 'json'], { cwd: clone })).stdout,
    ) as { services: Record<string, Record<string, unknown>> };
    for (const [name, service] of Object.entries(config.services)) {
      expect(service['env_file'], name).toBeUndefined();
    }

    const published = states
      .flatMap((state) => state.Publishers ?? [])
      .filter((publisher) => publisher.PublishedPort !== 0)
      .map((publisher) => `${publisher.URL}:${String(publisher.PublishedPort)}`)
      .sort();
    expect(published).toEqual(
      [
        '127.0.0.1:55432',
        '127.0.0.1:6379',
        '127.0.0.1:3001',
        '127.0.0.1:3002',
        '127.0.0.1:8080',
      ].sort(),
    );
  });

  it('DEP-AC02 services start in dependency order, read from docker inspect', () => {
    const startedAt = (service: string): bigint =>
      nanos(timeline.container(service).State.StartedAt);
    const migrate = timeline.container('migrate');

    expect(
      startedAt('migrate') > timeline.healthyAt('postgres'),
      `migrate started at ${migrate.State.StartedAt}; postgres probes: ${JSON.stringify(timeline.probesOf('postgres'))}`,
    ).toBe(true);

    expect(migrate.State.Status).toBe('exited');
    expect(migrate.State.ExitCode).toBe(0);
    const migrateFinished = nanos(migrate.State.FinishedAt);
    for (const replica of ['api-1', 'api-2']) {
      expect(startedAt(replica) > migrateFinished, replica).toBe(true);
    }

    const replicasHealthy = [timeline.healthyAt('api-1'), timeline.healthyAt('api-2')];
    for (const healthy of replicasHealthy) {
      expect(startedAt('nginx') > healthy).toBe(true);
    }
  });
});
