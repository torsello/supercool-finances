import http from 'node:http';
import { recordResponses } from './recorder.js';
import { BASE_URL } from './urls.js';

/** A response read whole: status, headers and the body's exact bytes as text. */
export interface E2eResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body as received, for byte-for-byte comparisons. */
  body: string;
  /** How long the request took, from sending it to the end of the body. */
  durationMs: number;
}

export interface E2eRequest {
  method?: string;
  /** A path, sent to `E2E_BASE_URL`, or an absolute URL, such as a replica's own port. */
  url: string;
  headers?: Record<string, string>;
  /** A JSON value is sent with `Content-Type: application/json`; a string as it is. */
  body?: unknown;
  /** Fails the request when no full response arrives in time. */
  timeoutMs?: number;
  agent?: http.Agent;
  /** False for a server of the test's own, whose responses are not the stack's. */
  record?: boolean;
}

/**
 * How long one address of a host name may take to connect before the next is tried. `localhost`
 * names `::1` and `127.0.0.1`, and Docker publishes the stack on `127.0.0.1` only: Node's default
 * of 250 ms gives up on it too soon when many connections open at once.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Keep-alive connections, as a client of the load balancer would use: at most 100 at once, since a
 * Docker VM on macOS forwards every published port through one connection of its own, which
 * thousands of connections at once can break; requests beyond them wait for a free one.
 */
const keepAlive = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
});

/**
 * Sends one request with Node's own HTTP client, which sends every header as given, and records
 * the response's status with the running test file (plan 007 section 6). A connection error
 * rejects, and records nothing: no response was received.
 */
export async function send(request: E2eRequest): Promise<E2eResponse> {
  const url = new URL(request.url, `${BASE_URL}/`);
  const headers: Record<string, string> = { ...request.headers };
  let payload: Buffer | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === 'string') {
      payload = Buffer.from(request.body, 'utf8');
    } else {
      payload = Buffer.from(JSON.stringify(request.body), 'utf8');
      headers['content-type'] ??= 'application/json';
    }
    headers['content-length'] = String(payload.length);
  }
  const started = performance.now();
  const response = await new Promise<E2eResponse>((resolve, reject) => {
    const outgoing = http.request(
      url,
      { method: request.method ?? 'GET', headers, agent: request.agent ?? keepAlive },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            durationMs: performance.now() - started,
          });
        });
      },
    );
    outgoing.once('error', reject);
    if (request.timeoutMs !== undefined) {
      outgoing.setTimeout(request.timeoutMs, () => {
        outgoing.destroy(new Error(`no response within ${String(request.timeoutMs)} ms`));
      });
    }
    outgoing.end(payload);
  });
  if (request.record !== false) recordResponses(response.status);
  return response;
}

/** The body parsed as JSON. */
export function jsonOf(response: E2eResponse): unknown {
  return JSON.parse(response.body);
}

/** A header's single value, or undefined. */
export function headerOf(response: E2eResponse, name: string): string | undefined {
  const value = response.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}

export type ProblemBody = Record<string, unknown> & {
  type: string;
  title: string;
  status: number;
  detail: string;
  requestId: string;
};

/** The problem details body of a response, after checking its content type (SYS-R24). */
export function problemOf(response: E2eResponse): ProblemBody {
  const contentType = headerOf(response, 'content-type');
  if (contentType !== 'application/problem+json') {
    throw new Error(
      `expected application/problem+json, got ${String(contentType)} with status ${String(response.status)}: ${response.body}`,
    );
  }
  return jsonOf(response) as ProblemBody;
}

/** Fails with the response's body unless it has `status`. */
export function expectStatus(response: E2eResponse, status: number): E2eResponse {
  if (response.status !== status) {
    throw new Error(
      `expected status ${String(status)}, got ${String(response.status)}: ${response.body}`,
    );
  }
  return response;
}

/** The `Authorization` header of a bearer token. */
export function bearer(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}
