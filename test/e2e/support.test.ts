import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';
import { send } from './support/http.js';
import { RESPONSES_PATH } from './support/paths.js';
import { readRecord, recordResponses } from './support/recorder.js';
import { E2eSequencer, FIRST, LAST, orderE2eFiles } from './support/sequencer.js';

/** The e2e test files, as Vitest finds them. */
function e2eFiles(): string[] {
  return readdirSync(new URL('./', import.meta.url)).filter((name) => name.endsWith('.test.ts'));
}

describe('the e2e support of plan 007 section 6', () => {
  it('the sequencer runs the empty-volume files first, the rate-limit record and the per-IP flood last, and the rest by name', () => {
    const files = e2eFiles();
    for (const name of [...FIRST, ...LAST]) expect(files).toContain(name);
    const shuffled = [...files]
      .sort(() => Math.random() - 0.5)
      .map((name) => `/repo/test/e2e/${name}`);

    const ordered = orderE2eFiles(shuffled, (path) => path).map((path) => path.split('/').at(-1));

    const middle = files.filter(
      (name) =>
        !(FIRST as readonly string[]).includes(name) && !(LAST as readonly string[]).includes(name),
    );
    expect(ordered).toEqual([...FIRST, ...[...middle].sort((a, b) => a.localeCompare(b)), ...LAST]);
    expect(ordered.slice(-2)).toEqual(['no-rate-limited.test.ts', 'edge-rate-limit.test.ts']);
  });

  it('the sequencer is the one Vitest runs with', () => {
    const resolved = config as { test?: { sequence?: { sequencer?: unknown } } };
    expect(resolved.test?.sequence?.sequencer).toBe(E2eSequencer);
  });

  it('the HTTP helper records each response’s status with its test file in the response record', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(204).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const before = readRecord().length;
      const response = await send({ url: `http://127.0.0.1:${String(port)}/` });
      expect(response.status).toBe(204);
      recordResponses(299, 3);
      const added = readRecord().slice(before);
      expect(added).toEqual([
        { file: 'test/e2e/support.test.ts', status: 204, count: 1 },
        { file: 'test/e2e/support.test.ts', status: 299, count: 3 },
      ]);
      expect(RESPONSES_PATH.endsWith('reports/e2e-responses.jsonl')).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
