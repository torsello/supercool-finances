import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Readiness, type ReadinessClient } from '../../../src/platform/health/health.js';

/** A readiness connection whose `SELECT 1` answers at once, or waits for `fail`. */
class FakeClient extends EventEmitter implements ReadinessClient {
  ended = false;
  #pending: ((error: Error) => void) | undefined;

  constructor(private readonly hangs: boolean) {
    super();
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  query(text: string): Promise<{ rows: unknown[] }> {
    if (this.hangs && text === 'SELECT 1') {
      return new Promise((_resolve, reject) => (this.#pending = reject));
    }
    const rows = text.includes('pgmigrations') ? [{ name: '1_first' }] : [{}];
    return Promise.resolve({ rows });
  }

  /** The statement in flight fails, as when the connection was lost. */
  fail(): void {
    this.#pending?.(new Error('Connection terminated unexpectedly'));
  }

  end(): Promise<void> {
    this.ended = true;
    return Promise.resolve();
  }
}

describe('readiness', () => {
  it('SEC-R24 a failed check drops only the connection it used, never one another check opened since', async () => {
    const clients = [new FakeClient(true), new FakeClient(false)];
    const opened: FakeClient[] = [];
    const warnings: unknown[] = [];
    const readiness = new Readiness({
      databaseUrl: 'postgres://unused',
      migrations: ['1_first'],
      logger: { warn: (fields) => warnings.push(fields) },
      timeoutMs: 60_000,
      client: () => {
        const client = clients[opened.length];
        if (client === undefined) throw new Error('no more clients');
        opened.push(client);
        return client;
      },
    });

    // Check A waits on the first connection, which is then lost.
    const first = readiness.ready();
    await new Promise((resolve) => setImmediate(resolve));
    clients[0]?.emit('error', new Error('connection lost'));
    // Check B opens the second connection and succeeds.
    expect(await readiness.ready()).toBe(true);
    // Only then does check A see its statement fail.
    clients[0]?.fail();
    expect(await first).toBe(false);

    expect(opened).toHaveLength(2);
    expect(clients[0]?.ended).toBe(true);
    expect(clients[1]?.ended).toBe(false);
    // The next check still uses the second connection.
    expect(await readiness.ready()).toBe(true);
    expect(opened).toHaveLength(2);
    expect(warnings).toEqual([{ check: 'database' }]);
  });
});
