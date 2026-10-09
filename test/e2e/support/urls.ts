import { readCompose } from '../../support/deployment.js';

/** The names of this machine's loopback, as `URL` writes them. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The load balancer of the stack, as the e2e suite reaches it: `E2E_BASE_URL`, without a trailing
 * slash, `http://localhost:8080` by default. Local only: the suite starts the stack on this
 * machine and reads its database, Redis and logs here, so another host would split the run
 * across two stacks; it may only change the loopback name or the port.
 */
export const BASE_URL = localBaseUrl(process.env['E2E_BASE_URL'] ?? 'http://localhost:8080');

function localBaseUrl(value: string): string {
  if (!LOOPBACK.has(new URL(value).hostname)) {
    throw new Error(
      `E2E_BASE_URL must name this machine (localhost, 127.0.0.1 or [::1]): the e2e suite starts the stack here and reads its database, Redis and logs on 127.0.0.1.`,
    );
  }
  return value.replace(/\/+$/, '');
}

/** The two replicas, each addressed on its own host port (SYS-AC14). */
export const REPLICAS = ['api-1', 'api-2'] as const;
export type Replica = (typeof REPLICAS)[number];

/** The host port a service of `compose.yaml` publishes for `containerPort`. */
export function publishedPort(service: string, containerPort: string): string {
  const port = readCompose()
    .service(service)
    .ports.find((item) => item.containerPort === containerPort);
  if (port?.hostPort === undefined) {
    throw new Error(`${service} publishes no host port for ${containerPort}`);
  }
  return port.hostPort;
}

/** A replica's own URL: the host of `E2E_BASE_URL` and the replica's published port. */
export function replicaUrl(replica: Replica): string {
  const url = new URL(BASE_URL);
  url.port = publishedPort(replica, '3000');
  return url.origin;
}
