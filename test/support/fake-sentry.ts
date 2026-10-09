import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Polls `done` every 20 ms until it holds, failing after `timeoutMs`. */
async function waitUntil(done: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One envelope as the endpoint received it. */
export interface ReceivedEnvelope {
  path: string;
  headers: IncomingHttpHeaders;
  /** The envelope's bytes, as sent. */
  body: string;
  /** The event item of the envelope. */
  event: Record<string, unknown> & { tags?: Record<string, string> };
  /** The status the endpoint answered, once it has. */
  answered?: number;
}

/**
 * A Sentry-compatible endpoint for the tests (plan 007): an HTTP server on 127.0.0.1 that records
 * every envelope it receives, and answers each with `status` after holding it `holdMs`.
 */
export class FakeSentry {
  readonly envelopes: ReceivedEnvelope[] = [];
  /** How long each envelope is held before it is answered. */
  holdMs = 0;
  /** The status each envelope is answered with. */
  status = 200;
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  /** Starts the endpoint on `port`, or on a free port when not given. */
  static async start(port = 0): Promise<FakeSentry> {
    const server = createServer();
    const fake = new FakeSentry(server);
    server.on('request', (request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const lines = body.split('\n');
        const envelope: ReceivedEnvelope = {
          path: request.url ?? '',
          headers: request.headers,
          body,
          event: JSON.parse(lines[2] ?? '{}') as ReceivedEnvelope['event'],
        };
        fake.envelopes.push(envelope);
        const status = fake.status;
        setTimeout(() => {
          envelope.answered = status;
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end('{}');
        }, fake.holdMs);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return fake;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  /** A DSN naming this endpoint over `http://`, which section 1.2 of spec 007 allows on 127.0.0.1. */
  dsn(publicKey = 'pk-fake-0001', project = 7): string {
    return dsnFor(this.port, publicKey, project);
  }

  /** The envelopes this endpoint has answered with a 2xx status. */
  accepted(): ReceivedEnvelope[] {
    return this.envelopes.filter(
      (envelope) => envelope.answered !== undefined && envelope.answered < 300,
    );
  }

  /** Waits until `count` envelopes have been received. */
  async waitForEnvelopes(count: number, timeoutMs = 5000): Promise<void> {
    await waitUntil(() => this.envelopes.length >= count, timeoutMs, `${String(count)} envelopes`);
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }
}

/** A DSN for an endpoint on `port` of 127.0.0.1, whether or not anything listens there. */
export function dsnFor(port: number, publicKey = 'pk-fake-0001', project = 7): string {
  return `http://${publicKey}@127.0.0.1:${String(port)}/${String(project)}`;
}
