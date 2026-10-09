import { execFile, spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { TEST_CURSOR_SECRET } from '../../support/app.js';
import { freePort } from '../../support/ports.js';
import { requireEnv } from '../../support/env.js';
import { K, TEST_AUDIENCE, TEST_ISSUER } from '../../support/tokens.js';

const run = promisify(execFile);

/** Whether a TCP connection to `port` on the loopback is accepted. */
async function accepts(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}

describe('startup with an invalid configuration', () => {
  beforeAll(async () => {
    // The production build, as SEC-AC31 runs it (plan 007 section 6).
    await run('npm', ['run', 'build'], { timeout: 120_000 });
  }, 120_000);

  it('SEC-AC31 the production build exits 1 within 5 seconds, names every invalid variable and never listens', async () => {
    const port = await freePort();
    const child = spawn(process.execPath, ['dist/main.js'], {
      env: {
        PATH: process.env['PATH'],
        DATABASE_URL: 'postgres://scf_app:db-pw-7781@127.0.0.1:1/unused',
        REDIS_URL: 'redis://:redis-pw-5512@127.0.0.1:1',
        JWT_SECRET: K,
        JWT_ISSUER: TEST_ISSUER,
        JWT_AUDIENCE: TEST_AUDIENCE,
        CURSOR_SECRET: TEST_CURSOR_SECRET,
        PORT: String(port),
        METRICS_PORT: String(port),
        DB_POOL_MAX: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const started = performance.now();
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => {
        resolve(code);
      });
    });

    // Probes the port until the process exits: any accepted connection means it listened.
    let listened = false;
    const state = { running: true };
    void exited.then(() => (state.running = false));
    while (state.running) {
      if (await accepts(port)) listened = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const code = await exited;

    expect(code).toBe(1);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(listened).toBe(false);
    expect(output).toContain('METRICS_PORT');
    expect(output).toContain('DB_POOL_MAX');
    for (const secret of [K, TEST_CURSOR_SECRET, 'db-pw-7781', 'redis-pw-5512']) {
      expect(output.includes(secret), secret).toBe(false);
    }
    // One error, written as one JSON log line.
    const lines = output.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 60 });
  });

  it('SEC-R21 a failure while building the app is written as one JSON line and exits 1 without listening', async () => {
    // A build whose migrations folder is empty: readiness cannot know what to check, so the app
    // is not built.
    rmSync('dist/migrations-moved', { recursive: true, force: true });
    renameSync('dist/migrations', 'dist/migrations-moved');
    mkdirSync('dist/migrations');
    let kill = () => undefined as unknown;
    try {
      const port = await freePort();
      const child = spawn(process.execPath, ['dist/main.js'], {
        env: {
          PATH: process.env['PATH'],
          DATABASE_URL: requireEnv('TEST_DATABASE_URL'),
          REDIS_URL: requireEnv('REDIS_URL'),
          JWT_SECRET: K,
          JWT_ISSUER: TEST_ISSUER,
          JWT_AUDIENCE: TEST_AUDIENCE,
          CURSOR_SECRET: TEST_CURSOR_SECRET,
          PORT: String(port),
          METRICS_PORT: String(await freePort()),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      kill = () => child.kill('SIGKILL');
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      const code = await new Promise<number | null>((resolve) => {
        child.once('exit', (exitCode) => {
          resolve(exitCode);
        });
      });

      expect(code).toBe(1);
      expect(await accepts(port)).toBe(false);
      const lines = output.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? '')).toMatchObject({ level: 60, msg: 'startup failed' });
      for (const secret of [K, TEST_CURSOR_SECRET]) expect(output.includes(secret)).toBe(false);
    } finally {
      kill();
      rmSync('dist/migrations', { recursive: true, force: true });
      renameSync('dist/migrations-moved', 'dist/migrations');
    }
  });
});
