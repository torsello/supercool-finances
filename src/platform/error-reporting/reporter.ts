import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SYSTEM_TIMERS, type Timers } from '../http/request-timeout.js';
import type { SentryDsn } from './dsn.js';
import { buildEvent, type EventSettings, type ReportedRequest } from './event.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The error reporter, or `undefined` when `SENTRY_DSN` is unset or empty (SEC-R51); called by
     * `logFailure` for each 500 (SEC-R50).
     */
    errorReporter: ErrorReporter | undefined;
  }
}

/** A report not sent within this time is abandoned and dropped (SEC-R54). */
export const SEND_TIMEOUT_MS = 2000;

/** At most this many reports wait or are in flight per replica; a further one is dropped (SEC-R54). */
export const MAX_PENDING_REPORTS = 20;

/** One envelope to post. */
export interface TransportRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  signal: AbortSignal;
}

/** Posts an envelope and answers its status; rejects when the endpoint cannot be reached. */
export interface Transport {
  send(request: TransportRequest): Promise<{ status: number }>;
}

/** Node's `fetch`, which never follows a redirect, so an envelope goes only where the DSN says. */
export const FETCH_TRANSPORT: Transport = {
  async send({ url, headers, body, signal }) {
    const response = await fetch(url, { method: 'POST', headers, body, signal, redirect: 'error' });
    await response.body?.cancel();
    return { status: response.status };
  },
};

/** The two lines the reporter writes: never one per report, never the DSN (SEC-R54). */
export interface ReporterLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  info(message: string): void;
}

export interface ReporterOptions {
  dsn: SentryDsn;
  settings: Omit<EventSettings, 'eventId' | 'timestamp'>;
  logger: ReporterLogger;
  transport?: Transport;
  timers?: Timers;
}

/** The application's folder and the `version` of its `package.json`, for every event. */
export function applicationInfo(): { appRoot: string; release: string } {
  // Three levels up from src/platform/error-reporting/ and from dist/platform/error-reporting/
  // alike: the repository root, or /app in the image, which holds package.json.
  const root = new URL('../../../', import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
    version: string;
  };
  return { appRoot: fileURLToPath(root), release: version };
}

/**
 * The error reporter of section 1.10 of spec 007, built only when `SENTRY_DSN` is set (SEC-R51).
 * `report` never throws and never waits: it builds the event from the allowlist, posts it as a
 * Sentry envelope in the background, abandons the send after `SEND_TIMEOUT_MS`, and drops a report
 * that fails, times out, gets a status other than 2xx, or finds `MAX_PENDING_REPORTS` already
 * pending (SEC-R54). Nothing waits for a pending report, the shutdown included (SEC-R55).
 */
export class ErrorReporter {
  readonly #dsn: SentryDsn;
  readonly #settings: Omit<EventSettings, 'eventId' | 'timestamp'>;
  readonly #logger: ReporterLogger;
  readonly #transport: Transport;
  readonly #timers: Timers;
  #pending = 0;
  #failing = false;

  constructor(options: ReporterOptions) {
    this.#dsn = options.dsn;
    this.#settings = options.settings;
    this.#logger = options.logger;
    this.#transport = options.transport ?? FETCH_TRANSPORT;
    this.#timers = options.timers ?? SYSTEM_TIMERS;
  }

  /** Reports waiting or in flight. */
  get pending(): number {
    return this.#pending;
  }

  /** Queues the report of `error`, raised while handling `request`, which was answered 500. */
  report(error: unknown, request: ReportedRequest): void {
    if (this.#pending >= MAX_PENDING_REPORTS) return;
    let body: string;
    try {
      body = this.#envelope(error, request);
    } catch {
      // A report that cannot be built is dropped; the request was answered already.
      return;
    }
    this.#pending += 1;
    const controller = new AbortController();
    const timer = this.#timers.setTimeout(() => {
      controller.abort();
    }, SEND_TIMEOUT_MS);
    void this.#send(body, controller.signal).then((outcome) => {
      this.#timers.clearTimeout(timer);
      this.#pending -= 1;
      this.#record(outcome);
    });
  }

  #envelope(error: unknown, request: ReportedRequest): string {
    const event = buildEvent(error, request, {
      ...this.#settings,
      eventId: randomUUID().replaceAll('-', ''),
      timestamp: Date.now() / 1000,
    });
    const header = { event_id: event.event_id, sent_at: new Date().toISOString() };
    const item = { type: 'event', content_type: 'application/json' };
    return `${JSON.stringify(header)}\n${JSON.stringify(item)}\n${JSON.stringify(event)}\n`;
  }

  async #send(body: string, signal: AbortSignal): Promise<Record<string, unknown> | 'sent'> {
    try {
      const { status } = await this.#transport.send({
        url: this.#dsn.envelopeUrl,
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.#dsn.publicKey}, sentry_client=supercool-finances/${this.#settings.release}`,
        },
        body,
        signal,
      });
      return status >= 200 && status < 300 ? 'sent' : { status };
    } catch {
      return { reason: signal.aborted ? 'timeout' : 'unreachable' };
    }
  }

  /** One line when sends start failing and one when one succeeds again (SEC-R54). */
  #record(outcome: Record<string, unknown> | 'sent'): void {
    if (outcome === 'sent') {
      if (this.#failing) this.#logger.info('error reporting works again');
      this.#failing = false;
      return;
    }
    if (!this.#failing) this.#logger.warn(outcome, 'error reporting is failing');
    this.#failing = true;
  }
}
