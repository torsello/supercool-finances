import { afterEach, describe, expect, it } from 'vitest';
import { FakeSentry } from '../../support/fake-sentry.js';

const ENVELOPE = [
  JSON.stringify({ event_id: 'e1' }),
  JSON.stringify({ type: 'event' }),
  JSON.stringify({ event_id: 'e1', tags: { requestId: 'r1' } }),
  '',
].join('\n');

async function post(fake: FakeSentry): Promise<{ status: number; ms: number }> {
  const started = Date.now();
  const response = await fetch(`http://127.0.0.1:${String(fake.port)}/api/7/envelope/`, {
    method: 'POST',
    body: ENVELOPE,
  });
  return { status: response.status, ms: Date.now() - started };
}

describe('the fake Sentry-compatible endpoint', () => {
  let fake: FakeSentry | undefined;

  afterEach(async () => {
    await fake?.close();
  });

  it('SEC-R50 records each envelope with its event, answers it, holds it when told, and refuses it with another status', async () => {
    fake = await FakeSentry.start();
    expect(fake.dsn('pk-x', 9)).toBe(`http://pk-x@127.0.0.1:${String(fake.port)}/9`);

    expect((await post(fake)).status).toBe(200);
    expect(fake.envelopes).toHaveLength(1);
    expect(fake.envelopes[0]?.path).toBe('/api/7/envelope/');
    expect(fake.envelopes[0]?.event.tags?.['requestId']).toBe('r1');
    expect(fake.accepted()).toHaveLength(1);

    fake.holdMs = 300;
    expect((await post(fake)).ms).toBeGreaterThanOrEqual(290);
    fake.holdMs = 0;
    fake.status = 503;
    expect((await post(fake)).status).toBe(503);
    expect(fake.envelopes).toHaveLength(3);
    expect(fake.accepted()).toHaveLength(2);
    await fake.waitForEnvelopes(3);
  });
});
