// The client of SEC-AC01, run inside the stack's network by the tools service:
// `npx tsx test/e2e/support/flood-client.ts <url> <count> <pause ms>`. It sends `count` requests to
// `url` at the same time, each on its own connection with its own X-Forwarded-For, waits `pause`,
// sends one more, and prints every answer as one JSON document. It runs there, not on the host,
// because thousands of connections at once overwhelm the port forwarding of a Docker VM on macOS.
import http from 'node:http';

interface Answer {
  status: number;
  retryAfter: string | undefined;
  contentType: string | undefined;
  requestId: string | undefined;
  body: string;
}

const agent = new http.Agent({ keepAlive: false, maxSockets: Infinity });

async function get(url: string, forwardedFor?: string): Promise<Answer> {
  return await new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { agent, headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const header = (name: string): string | undefined => {
            const value = response.headers[name];
            return Array.isArray(value) ? value.join(', ') : value;
          };
          resolve({
            status: response.statusCode ?? 0,
            retryAfter: header('retry-after'),
            contentType: header('content-type'),
            requestId: header('x-request-id'),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.once('error', reject);
  });
}

const [url = 'http://nginx:8080/health/live', count = '3000', pause = '3000'] =
  process.argv.slice(2);
const answers = await Promise.all(
  Array.from(
    { length: Number(count) },
    async (_, index) =>
      await get(
        url,
        `10.${String(index >> 16)}.${String((index >> 8) & 255)}.${String(index & 255)}`,
      ),
  ),
);
await new Promise((resolve) => setTimeout(resolve, Number(pause)));
const last = await get(url);
process.stdout.write(`${JSON.stringify({ answers, last })}\n`);
