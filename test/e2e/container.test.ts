import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCompose } from '../support/deployment.js';
import { runOk } from './support/command.js';
import {
  containerLogs,
  containerOf,
  ensureStack,
  jsonLines,
  restoreReplicas,
  stopServices,
} from './support/stack.js';

/** `SHUTDOWN_DRAIN_DELAY_MS` of the replicas: `compose.yaml`'s value, or the default 2000 (spec 007 section 1.2). */
function drainDelayMs(): number {
  return Number(readCompose().service('api-1').environment['SHUTDOWN_DRAIN_DELAY_MS'] ?? '2000');
}

describe('a replica container', () => {
  beforeAll(ensureStack);
  afterAll(restoreReplicas);

  it('DEP-AC13 runs healthy as uid 1000 with node as process 1, holds no sources or dev tools, and stops cleanly on SIGTERM', async () => {
    const container = await containerOf('api-1');
    expect(container.State.Health?.Status).toBe('healthy');
    const exec = async (...args: string[]): Promise<string> =>
      (await runOk('docker', ['exec', container.Id, ...args])).stdout;

    // Process 1 is node, as user 1000.
    const command = (await exec('cat', '/proc/1/cmdline'))
      .split('\0')
      .filter((part) => part !== '');
    expect(command[0]?.split('/').at(-1)).toBe('node');
    expect(command.slice(1)).toEqual(['dist/main.js']);
    const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(
      await exec('cat', '/proc/1/status'),
    );
    expect(uids?.slice(1)).toEqual(['1000', '1000', '1000', '1000']);
    // BusyBox's ps shows the name of Node's main thread, {MainThread}, before its command line.
    const processes = await exec('ps', '-o', 'pid,user,args');
    expect(processes).toMatch(/^\s*1\s+node\s+(?:\{MainThread\}\s+)?node dist\/main\.js$/m);

    // The files present: no sources, tests or development tools, and none owned by node.
    const top = (await exec('ls', '-A', '/app')).split('\n').filter((name) => name !== '');
    expect(top).not.toContain('src');
    expect(top).not.toContain('test');
    expect(top).toContain('dist');
    expect(
      (await exec('find', '/app', '-name', 'typescript', '-o', '-name', 'vitest')).trim(),
    ).toBe('');
    expect((await exec('find', '/app', '-user', 'node')).trim()).toBe('');

    // SIGTERM from `docker compose stop` runs the shutdown of SEC-R25, and the exit is 0, in time.
    const started = performance.now();
    await stopServices(['api-1']);
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(drainDelayMs() + 5000);
    const stopped = await containerOf('api-1');
    expect(stopped.State.Status).toBe('exited');
    expect(stopped.State.ExitCode).toBe(0);
    const messages = jsonLines(await containerLogs('api-1'))
      .map((line) => line['msg'])
      .slice(-5);
    expect(messages).toEqual(
      expect.arrayContaining([
        'shutting down on SIGTERM: readiness answers 503',
        'stopped accepting connections',
        'shutdown complete',
      ]),
    );
    expect(messages.at(-1)).toBe('shutdown complete');
  });
});
