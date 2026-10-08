import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CursorCodec } from '../../../src/modules/accounts/adapters/http/cursor.js';
import { MalformedRequest } from '../../../src/platform/http/errors.js';

const SECRET = 'test-only-cursor-secret-for-the-cursor-unit-tests';
const OTHER_SECRET = 'another-cursor-secret-of-at-least-thirty-two-bytes';
const C1 = '0192f0a0-0000-7000-8000-0000000000c1';
const C2 = '0192f0a0-0000-7000-8000-0000000000c2';
const A1 = '0192f0a0-0000-7000-8000-0000000000a1';
const A2 = '0192f0a0-0000-7000-8000-0000000000a2';
const POSITION = {
  createdAt: '2026-10-07T12:00:01.000500Z',
  id: '0192f0a0-0000-7000-8000-000000000e05',
};

const codec = new CursorCodec(SECRET);
const accounts = { list: 'accounts', userId: C1 } as const;
const entries = { list: 'entries', userId: C1, accountId: A1 } as const;

function refused(text: string, scope: Parameters<CursorCodec['decode']>[1], using = codec): void {
  let error: unknown;
  try {
    using.decode(text, scope);
  } catch (caught) {
    error = caught;
  }
  expect(error, text).toBeInstanceOf(MalformedRequest);
  expect((error as MalformedRequest).part).toBe('cursor');
}

/** A cursor with any payload, signed with `secret`, as the codec lays it out. */
function signed(payload: unknown, secret = SECRET): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const tag = createHmac('sha256', secret).update(bytes).digest();
  return Buffer.concat([bytes, tag]).toString('base64url');
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('the cursor codec', () => {
  it('ACC-R23 round-trips a position of the account list and of a history', () => {
    const forList = codec.encode(accounts, POSITION);
    expect(forList).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(codec.decode(forList, accounts)).toEqual(POSITION);
    expect(codec.decode(codec.encode(entries, POSITION), entries)).toEqual(POSITION);
  });

  it('ACC-R23 lays a cursor out as base64url of the JSON payload and its HMAC-SHA256 tag', () => {
    const text = codec.encode(entries, POSITION);
    expect(text).toBe(
      signed({ l: 'entries', u: C1, a: A1, t: POSITION.createdAt, i: POSITION.id }),
    );
    expect(codec.encode(accounts, POSITION)).toBe(
      signed({ l: 'accounts', u: C1, t: POSITION.createdAt, i: POSITION.id }),
    );
  });

  it('ACC-R23 refuses every cursor with one character altered', () => {
    const text = codec.encode(entries, POSITION);
    for (let index = 0; index < text.length; index += 1) {
      const current = BASE64URL.indexOf(text[index] ?? '');
      for (const flip of [1, 32]) {
        const altered = `${text.slice(0, index)}${BASE64URL[current ^ flip] ?? 'A'}${text.slice(index + 1)}`;
        refused(altered, entries);
      }
    }
  });

  it('ACC-R23 refuses random base64url, a short text, text that is not base64url and an empty cursor', () => {
    const random = Buffer.from(
      Array.from({ length: 120 }, (_, index) => (index * 37) % 256),
    ).toString('base64url');
    for (const text of [
      random,
      Buffer.alloc(32).toString('base64url'),
      Buffer.alloc(33).toString('base64url'),
      'not a cursor!',
      'not-a-cursor',
      `${codec.encode(accounts, POSITION)}=`,
      '',
    ]) {
      refused(text, accounts);
    }
  });

  it('ACC-R23 refuses a cursor of another list, user or account', () => {
    refused(codec.encode(accounts, POSITION), entries);
    refused(codec.encode(entries, POSITION), accounts);
    refused(codec.encode(accounts, POSITION), { list: 'accounts', userId: C2 });
    refused(codec.encode(entries, POSITION), { list: 'entries', userId: C2, accountId: A1 });
    refused(codec.encode(entries, POSITION), { list: 'entries', userId: C1, accountId: A2 });
  });

  it('ACC-R23 refuses a correctly signed payload that does not have the shape of a cursor', () => {
    const base = { l: 'accounts', u: C1, t: POSITION.createdAt, i: POSITION.id };
    for (const payload of [
      { ...base, t: '2026-10-07T12:00:01.000Z' },
      { ...base, t: 'yesterday' },
      { ...base, i: 'not-a-uuid' },
      { ...base, i: POSITION.id.toUpperCase() },
      { ...base, extra: true },
      { ...base, a: A1 },
      { l: 'entries', u: C1, t: POSITION.createdAt, i: POSITION.id },
      [base],
      'cursor',
    ]) {
      refused(signed(payload), accounts);
    }
  });

  it('ACC-R30 accepts a cursor on every codec with the same secret, and refuses one signed with another', () => {
    const text = codec.encode(entries, POSITION);
    expect(new CursorCodec(SECRET).decode(text, entries)).toEqual(POSITION);
    refused(text, entries, new CursorCodec(OTHER_SECRET));
    refused(
      signed({ l: 'entries', u: C1, a: A1, t: POSITION.createdAt, i: POSITION.id }, OTHER_SECRET),
      entries,
    );
  });
});
