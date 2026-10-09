import { describe, expect, it } from 'vitest';
import { parseSentryDsn, type SentryDsn } from '../../../src/platform/error-reporting/dsn.js';
import {
  ErrorReporter,
  MAX_PENDING_REPORTS,
  SEND_TIMEOUT_MS,
  type Transport,
  type TransportRequest,
} from '../../../src/platform/error-reporting/reporter.js';
import type { ReportedRequest } from '../../../src/platform/error-reporting/event.js';
import { ShutdownCoordinator, WorkTracker } from '../../../src/platform/lifecycle/shutdown.js';
import { FakeClock, settle } from '../../support/clock.js';

const DSN = parseSentryDsn('https://pk-unit-7781@errors.example/42') as SentryDsn;

const REQUEST: ReportedRequest = {
  id: 'err-unit',
  method: 'GET',
  is404: false,
  routeOptions: { url: '/v1/test/throw' },
  headers: {},
};

/** A transport that records each send and answers only when told, or never. */
class RecordingTransport implements Transport {
  readonly sends: { request: TransportRequest; aborted: boolean }[] = [];
  readonly #answers: ((status: number) => void)[] = [];

  async send(request: TransportRequest): Promise<{ status: number }> {
    const record = { request, aborted: false };
    this.sends.push(record);
    return await new Promise((resolve, reject) => {
      this.#answers.push((status) => {
        resolve({ status });
      });
      request.signal.addEventListener('abort', () => {
        record.aborted = true;
        reject(new Error('aborted'));
      });
    });
  }

  answerAll(status: number): void {
    for (const answer of this.#answers.splice(0)) answer(status);
  }
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
  it('SEC-AC46 keeps at most 20 reports pending, abandons each send at 2000 ms, and the shutdown never waits for one', async () => {
    expect(MAX_PENDING_REPORTS).toBe(20);
    expect(SEND_TIMEOUT_MS).toBe(2000);
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const reporter = reporterWith(clock, transport, []);

    for (let index = 0; index < 25; index += 1) reporter.report(new Error('boom'), REQUEST);

    expect(transport.sends).toHaveLength(20);
    expect(reporter.pending).toBe(20);
    await clock.advanceTo(1999);
    expect(transport.sends.filter((send) => send.aborted)).toHaveLength(0);
    expect(reporter.pending).toBe(20);
    await clock.advanceTo(2000);
    expect(transport.sends.every((send) => send.aborted)).toBe(true);
    expect(reporter.pending).toBe(0);

    for (let index = 0; index < 3; index += 1) reporter.report(new Error('boom'), REQUEST);
    expect(transport.sends).toHaveLength(23);
    expect(reporter.pending).toBe(3);

    const calls: string[] = [];
    const closer = (name: string) => async () => {
      calls.push(`${name} closed`);
      await Promise.resolve();
    };
    const shutdown = new ShutdownCoordinator({
      timers: clock,
      drainDelayMs: 0,
      timeoutMs: 30000,
      work: new WorkTracker(),
      readiness: { stop: () => calls.push('readiness 503') },
      server: {
        stopAccepting: () => calls.push('stopped accepting'),
        closeIdleConnections: () => calls.push('idle connections closed'),
      },
      resources: [
        ['pool', closer('pool')],
        ['readiness connection', closer('readiness connection')],
        ['redis', closer('redis')],
      ],
      logger: { info: () => undefined, warn: () => undefined },
    });
    let code: number | undefined;
    void shutdown.shutdown('SIGTERM').then((value) => (code = value));
    await clock.advanceTo(2001);

    expect(calls.slice(-3)).toEqual(['pool closed', 'readiness connection closed', 'redis closed']);
    expect(code).toBe(0);
    expect(reporter.pending).toBe(3);
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
