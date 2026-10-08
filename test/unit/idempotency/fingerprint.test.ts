import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  fingerprint,
  NOT_CANONICAL_MARKER,
} from '../../../src/modules/idempotency/index.js';

const a = '018f2a00-0000-7000-8000-00000000000a';
const withdrawals = `/accounts/${a}/withdrawals`;

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('request fingerprint', () => {
  it('IDM-AC06 ignores key order and whitespace at every level and changes with any other difference in method, path or body', () => {
    const bodies = [
      '{"amount":"100","currency":"EUR"}',
      '{"currency":"EUR","amount":"100"}',
      '{ "amount" : "100" ,  "currency" : "EUR" }',
    ].map((text) => JSON.parse(text) as unknown);
    const [first, second, third] = bodies.map((body) => fingerprint('POST', withdrawals, body));
    expect(first).toBe(second);
    expect(first).toBe(third);
    expect(first).toBe(sha256(`POST\n${withdrawals}\n{"amount":"100","currency":"EUR"}`));
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const nested = fingerprint(
      'POST',
      '/x',
      JSON.parse('{"b":{"y":1,"x":[2,{"d":3,"c":4}]},"a":"1"}') as unknown,
    );
    expect(
      fingerprint(
        'POST',
        '/x',
        JSON.parse('{"a":"1","b":{"x":[2,{"c":4,"d":3}],"y":1}}') as unknown,
      ),
    ).toBe(nested);

    const body = { amount: '100', currency: 'EUR' };
    expect(fingerprint('POST', withdrawals, { amount: '101', currency: 'EUR' })).not.toBe(first);
    expect(fingerprint('POST', `/accounts/${a}/transfers`, body)).not.toBe(first);
    expect(fingerprint('POST', `/accounts/${a.toUpperCase()}/withdrawals`, body)).not.toBe(first);
    expect(
      fingerprint(
        'POST',
        '/x',
        JSON.parse('{"a":"1","b":{"x":[{"c":4,"d":3},2],"y":1}}') as unknown,
      ),
    ).not.toBe(nested);
  });

  it('IDM-R05 hashes the UTF-8 bytes of method, line feed, path, line feed and canonical body', () => {
    const body = { note: 'café €' };
    expect(fingerprint('POST', '/v1/accounts', body)).toBe(
      createHash('sha256')
        .update(Buffer.from('POST\n/v1/accounts\n{"note":"café €"}', 'utf8'))
        .digest('hex'),
    );
    expect(fingerprint('PUT', '/v1/accounts', body)).not.toBe(
      fingerprint('POST', '/v1/accounts', body),
    );
  });

  it('IDM-R05 serializes the RFC 8785 example of section 3.2.2 exactly: literals, numbers and minimal string escapes', () => {
    // The parsed input: "€$\u000F\u000aA'B"\\\\"\/" is € $ U+000F LF A ' B " \ \ " /.
    const input = {
      // Parsed from the RFC's text, which has more digits than a double holds.
      numbers: JSON.parse(
        '[333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001]',
      ) as unknown,
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('IDM-R05 sorts object keys by UTF-16 code units, as the RFC 8785 example of section 3.2.3', () => {
    const input = JSON.parse(
      String.raw`{
        "€": "Euro Sign",
        "\r": "Carriage Return",
        "דּ": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "😀": "Emoji: Grinning Face",
        "\u0080": "Control",
        "ö": "Latin Small Letter O With Diaeresis"
      }`,
    ) as unknown;
    expect(canonicalJson(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",' +
        '"ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign",' +
        '"😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('IDM-R05 writes no whitespace, keeps array order and escapes control characters in lowercase hex', () => {
    expect(canonicalJson({ b: [3, 1, 2], a: { d: null, c: ' x ' } })).toBe(
      '{"a":{"c":" x ","d":null},"b":[3,1,2]}',
    );
    expect(canonicalJson('\u0000\u001f\b\t\n\f\r"\\/é')).toBe(
      String.raw`"\u0000\u001f\b\t\n\f\r\"\\/é"`,
    );
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson(-0)).toBe('0');
  });

  it('IDM-R05 refuses a value that is not JSON instead of fingerprinting it', () => {
    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      () => 1,
      { a: undefined },
    ]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });
  /** `levels` arrays nested in one another, as `JSON.parse` returns them. */
  function nested(levels: number): unknown {
    return JSON.parse(`${'['.repeat(levels)}${']'.repeat(levels)}`) as unknown;
  }

  it('IDM-R05 accepts 64 levels of nesting and refuses a body RFC 8785 cannot encode: 1e400, 65 levels and 3000 levels of nested arrays', () => {
    expect(canonicalJson(nested(64))).toBe(`${'['.repeat(64)}${']'.repeat(64)}`);
    expect(canonicalJson({ a: nested(63) })).toBe(`{"a":${'['.repeat(63)}${']'.repeat(63)}}`);
    for (const body of [
      JSON.parse('{"amount":1e400,"currency":"EUR"}') as unknown,
      nested(65),
      { a: nested(64) },
      nested(3000),
    ]) {
      expect(() => canonicalJson(body)).toThrow(TypeError);
    }
  });

  it('IDM-AC06 fingerprints a body with 1e400 and a body nested deeper than 64 levels without an error, as the method, the path and the fixed marker, which differ from the fingerprints of the other bodies of the AC', () => {
    expect(() => JSON.parse(NOT_CANONICAL_MARKER) as unknown).toThrow(SyntaxError);
    const marked = sha256(`POST\n${withdrawals}\n${NOT_CANONICAL_MARKER}`);
    for (const body of [
      JSON.parse('{"amount":1e400,"currency":"EUR"}') as unknown,
      nested(65),
      nested(3000),
    ]) {
      expect(fingerprint('POST', withdrawals, body)).toBe(marked);
    }
    // The marker as a JSON string is canonical JSON, with its quotes, so it gets another fingerprint.
    expect(fingerprint('POST', withdrawals, NOT_CANONICAL_MARKER)).not.toBe(marked);
    expect(fingerprint('POST', withdrawals, nested(64))).not.toBe(marked);
    expect(fingerprint('POST', `/accounts/${a}/deposits`, nested(3000))).not.toBe(marked);

    const body = { amount: '100', currency: 'EUR' };
    const others = [
      fingerprint('POST', withdrawals, body),
      fingerprint('POST', withdrawals, { amount: '101', currency: 'EUR' }),
      fingerprint('POST', `/accounts/${a}/transfers`, body),
      fingerprint('POST', `/accounts/${a.toUpperCase()}/withdrawals`, body),
      fingerprint(
        'POST',
        '/x',
        JSON.parse('{"a":"1","b":{"x":[2,{"c":4,"d":3}],"y":1}}') as unknown,
      ),
      fingerprint(
        'POST',
        '/x',
        JSON.parse('{"a":"1","b":{"x":[{"c":4,"d":3},2],"y":1}}') as unknown,
      ),
    ];
    expect(others).not.toContain(marked);
  });
});
