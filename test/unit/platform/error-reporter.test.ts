import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildApp, createShutdown } from '../../../src/app.js';
import { loadConfig } from '../../../src/platform/config/config.js';
import { parseSentryDsn, type SentryDsn } from '../../../src/platform/error-reporting/dsn.js';
import {
  ErrorReporter,
  MAX_PENDING_REPORTS,
  SEND_TIMEOUT_MS,
  type Transport,
  type TransportRequest,
} from '../../../src/platform/error-reporting/reporter.js';
import type { ReportedRequest } from '../../../src/platform/error-reporting/event.js';
import { WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import { FakeClock, settle } from '../../support/clock.js';
import { TEST_CURSOR_SECRET } from '../../support/app.js';
import { K } from '../../support/tokens.js';
import { coordinator, watch } from './shutdown-fakes.js';

const DSN = parseSentryDsn('https://pk-unit-7781@errors.example/42') as SentryDsn;

const REQUEST: ReportedRequest = {
  id: 'err-unit',
  method: 'GET',
  is404: false,
  routeOptions: { url: '/v1/test/throw' },
  headers: {},
};

/** A transport that records each send and answers only when told: it never rejects on abort. */
class RecordingTransport implements Transport {
  readonly sends: { request: TransportRequest; aborted: boolean }[] = [];
  readonly #answers: ((status: number) => void)[] = [];

  async send(request: TransportRequest): Promise<{ status: number }> {
    const record = { request, aborted: false };
    this.sends.push(record);
    request.signal.addEventListener('abort', () => {
      record.aborted = true;
    });
    return await new Promise((resolve) => {
      this.#answers.push((status) => {
        resolve({ status });
      });
    });
  }

  answerAll(status: number): void {
    for (const answer of this.#answers.splice(0)) answer(status);
  }
}

/**
 * A TCP server on the loopback that accepts every connection and never answers, so each envelope
 * sent to it stays in flight until the reporter abandons it.
 */
async function silentEndpoint(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

interface LoggedLine {
  level: 'warn' | 'info';
  message: string;
  fields?: Record<string, unknown>;
}

function reporterWith(clock: FakeClock, transport: Transport, lines: LoggedLine[]) {
  return new ErrorReporter({
    dsn: DSN,
    settings: {
      environment: 'test',
      release: '0.1.0',
      replicaId: 'api-1',
      secrets: [],
      appRoot: '/app',
    },
    transport,
    timers: clock,
    logger: {
      warn: (fields, message) => lines.push({ level: 'warn', message, fields }),
      info: (message) => lines.push({ level: 'info', message }),
    },
  });
}

describe('the error reporter', () => {
  it('SEC-AC46 keeps at most 20 reports pending, abandons each send at 2000 ms even when the transport never answers, and the shutdown never waits for one', async () => {
    expect(MAX_PENDING_REPORTS).toBe(20);
    expect(SEND_TIMEOUT_MS).toBe(2000);
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const lines: LoggedLine[] = [];
    const reporter = reporterWith(clock, transport, lines);

    for (let index = 0; index < 25; index += 1) reporter.report(new Error('boom'), REQUEST);

    expect(transport.sends).toHaveLength(20);
    expect(reporter.pending).toBe(20);
    await clock.advanceTo(1999);
    expect(transport.sends.filter((send) => send.aborted)).toHaveLength(0);
    expect(reporter.pending).toBe(20);
    await clock.advanceTo(2000);
    // The transport ignored the abort and will never answer: the reporter frees the slots itself.
    expect(transport.sends.every((send) => send.aborted)).toBe(true);
    expect(reporter.pending).toBe(0);
    expect(lines).toEqual([
      { level: 'warn', message: 'error reporting is failing', fields: { reason: 'timeout' } },
    ]);

    for (let index = 0; index < 3; index += 1) reporter.report(new Error('boom'), REQUEST);
    expect(transport.sends).toHaveLength(23);
    expect(reporter.pending).toBe(3);

    // The shutdown coordinator of SEC-AC21, on the same injected clock as the reporter, its three
    // sends in flight: SIGTERM with no drain delay and no request in flight.
    const calls: string[] = [];
    const state = watch(
      coordinator(clock, new WorkTracker(), calls, {
        drainDelayMs: 0,
        timeoutMs: 40_000,
      }).shutdown('SIGTERM'),
    );
    await clock.advanceTo(2000);
    expect(calls).toEqual([
      'readiness 503',
      'stopped accepting',
      'idle connections closed',
      'pool closed',
      'readiness connection closed',
      'redis closed',
    ]);
    expect(state.code).toBe(0);
    // It did not wait for the reports: the three sends are still in flight.
    expect(reporter.pending).toBe(3);
    expect(transport.sends.slice(20).some((send) => send.aborted)).toBe(false);

    // The shutdown of the composition root, with the reporter main.ts builds, three of its
    // reports in flight to an endpoint that never answers.
    const endpoint = await silentEndpoint();
    const config = loadConfig({
      // The pool and Redis connect lazily, so this app never reaches either.
      DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
      JWT_SECRET: K,
      JWT_ISSUER: 'scf-test',
      JWT_AUDIENCE: 'scf-api',
      CURSOR_SECRET: TEST_CURSOR_SECRET,
      LOG_LEVEL: 'fatal',
      SHUTDOWN_DRAIN_DELAY_MS: '0',
      SENTRY_DSN: `http://pk-unit-7781@127.0.0.1:${String(endpoint.port)}/42`,
    });
    const app = buildApp(config);
    try {
      const composed = app.errorReporter;
      expect(composed).toBeDefined();
      for (let index = 0; index < 3; index += 1) composed?.report(new Error('boom'), REQUEST);
      expect(composed?.pending).toBe(3);

      const started = Date.now();
      const code = await createShutdown(app, config).shutdown('SIGTERM');

      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(SEND_TIMEOUT_MS);
      expect(composed?.pending).toBe(3);
    } finally {
      await app.close();
      await endpoint.close();
    }
  });

  it('SEC-R54 ignores an answer that arrives after its send was abandoned', async () => {
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const lines: LoggedLine[] = [];
    const reporter = reporterWith(clock, transport, lines);

    reporter.report(new Error('boom'), REQUEST);
    await clock.advanceTo(2000);
    expect(reporter.pending).toBe(0);
    transport.answerAll(200);
    await settle();

    expect(reporter.pending).toBe(0);
    expect(lines).toEqual([
      { level: 'warn', message: 'error reporting is failing', fields: { reason: 'timeout' } },
    ]);
  });

  it('SEC-R54 posts one envelope per report to the DSN with its key, and logs one warn line when sends start failing and one info line when one succeeds again', async () => {
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const lines: LoggedLine[] = [];
    const reporter = reporterWith(clock, transport, lines);

    reporter.report(new Error('boom'), REQUEST);
    const [first] = transport.sends;
    expect(first?.request.url).toBe('https://errors.example/api/42/envelope/');
    expect(first?.request.headers['content-type']).toBe('application/x-sentry-envelope');
    expect(first?.request.headers['x-sentry-auth']).toContain('sentry_key=pk-unit-7781');
    const [header, item, payload] = (first?.request.body ?? '').split('\n');
    const event = JSON.parse(payload ?? '') as { event_id: string; tags: { requestId: string } };
    expect(JSON.parse(header ?? '')).toMatchObject({ event_id: event.event_id });
    expect(JSON.parse(item ?? '')).toMatchObject({ type: 'event' });
    expect(event.tags.requestId).toBe('err-unit');
    expect(first?.request.body).not.toContain('pk-unit-7781');

    transport.answerAll(500);
    await settle();
    reporter.report(new Error('boom'), REQUEST);
    transport.answerAll(429);
    await settle();
    expect(lines).toEqual([
      { level: 'warn', message: 'error reporting is failing', fields: { status: 500 } },
    ]);
    reporter.report(new Error('boom'), REQUEST);
    transport.answerAll(200);
    await settle();
    reporter.report(new Error('boom'), REQUEST);
    transport.answerAll(202);
    await settle();
    expect(lines.slice(1)).toEqual([{ level: 'info', message: 'error reporting works again' }]);
    expect(reporter.pending).toBe(0);
    expect(JSON.stringify(lines)).not.toContain('pk-unit-7781');
  });

  it('SEC-R54 never throws, even when the event cannot be built or sent', async () => {
    const clock = new FakeClock();
    const failing: Transport = {
      send: () => Promise.reject(new Error('connection refused')),
    };
    const lines: LoggedLine[] = [];
    const reporter = reporterWith(clock, failing, lines);
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
    };
    Object.setPrototypeOf(hostile, Error.prototype);

    expect(() => {
      reporter.report(hostile, REQUEST);
      reporter.report(new Error('boom'), REQUEST);
    }).not.toThrow();
    await settle();
    expect(reporter.pending).toBe(0);
    expect(lines.map((line) => line.message)).toEqual(['error reporting is failing']);
  });
});
