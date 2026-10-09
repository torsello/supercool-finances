import { connect, createServer, type Server, type Socket } from 'node:net';
import { freePort } from './ports.js';

/**
 * A TCP port the test owns, for a dependency that is down and then starts (plan 007 section 6):
 * until `start`, nothing listens on it, so a connection is refused; from `start` on, every
 * connection is forwarded to the real server at `target`. `stop` closes the port and every
 * connection again.
 */
export class TcpProxy {
  readonly #target: { host: string; port: number };
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;

  private constructor(
    readonly port: number,
    target: { host: string; port: number },
  ) {
    this.#target = target;
  }

  /** A proxy on a free loopback port that forwards to `targetUrl`'s host and port once started. */
  static async to(targetUrl: string): Promise<TcpProxy> {
    const url = new URL(targetUrl);
    return new TcpProxy(await freePort(), { host: url.hostname, port: Number(url.port) });
  }

  async start(): Promise<void> {
    const server = createServer((client) => {
      const upstream = connect(this.#target);
      for (const socket of [client, upstream]) {
        this.#sockets.add(socket);
        socket.on('close', () => this.#sockets.delete(socket));
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
    this.#server = server;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    if (server === undefined) return;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}
