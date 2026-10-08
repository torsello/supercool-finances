import { createServer } from 'node:net';

/**
 * A TCP port on the loopback that nothing listens on at the time of the call: the operating
 * system picks it for a server that closes at once. Another process may take it afterwards, which
 * the tests accept for ports they use within moments.
 */
export async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('the server has no TCP address'));
          return;
        }
        resolve(address.port);
      });
    });
  });
}
