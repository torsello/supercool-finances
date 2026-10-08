import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { main } from '../../../src/modules/auth/adapters/cli/token.js';
import { C1, decodeToken, K, segments, T } from '../../support/tokens.js';

const ENV = { JWT_SECRET: K, JWT_ISSUER: 'scf-test', JWT_AUDIENCE: 'scf-api' };

/** Runs the token script with a clock at T + 0.75 s and captures its output. */
async function run(argv: string[], env: Record<string, string | undefined> = ENV) {
  let stdout = '';
  let stderr = '';
  const code = await main(
    argv,
    env,
    { write: (text: string) => (stdout += text) },
    { write: (text: string) => (stderr += text) },
    () => T * 1000 + 750,
  );
  return { code, stdout, stderr };
}

describe('the token script', () => {
  it('AUT-AC13 refuses bad arguments and configuration: non-zero exit, nothing on stdout, a message naming the fault, and no secret', async () => {
    const s31 = '0123456789012345678901234567890';
    expect(Buffer.byteLength(s31, 'utf8')).toBe(31);
    const cases: [string[], Record<string, string | undefined>, string][] = [
      [['--role', 'customer'], ENV, '--sub'],
      [['--sub', 'not-a-uuid', '--role', 'customer'], ENV, '--sub'],
      [['--sub', C1], ENV, '--role'],
      [['--sub', C1, '--role', 'admin'], ENV, '--role'],
      [['--sub', C1, '--role', 'customer', '--ttl', '3600'], ENV, '--ttl'],
      [['--sub', C1, '--role', 'customer'], { ...ENV, JWT_SECRET: undefined }, 'JWT_SECRET'],
      [['--sub', C1, '--role', 'customer'], { ...ENV, JWT_SECRET: s31 }, 'JWT_SECRET'],
    ];
    for (const [argv, env, fault] of cases) {
      const { code, stdout, stderr } = await run(argv, env);
      const label = `${argv.join(' ')} ${env['JWT_SECRET'] === undefined ? '(no JWT_SECRET)' : ''}`;
      expect(code, label).not.toBe(0);
      expect(stdout, label).toBe('');
      expect(stderr, label).toContain(fault);
      expect(stderr, label).not.toContain(K);
      expect(stderr, label).not.toContain(s31);
    }
  });

  it('AUT-R17 refuses a positional argument and a missing value', async () => {
    for (const argv of [
      ['--sub', C1, '--role', 'customer', 'extra'],
      ['--sub', C1, '--role'],
    ]) {
      const { code, stdout, stderr } = await run(argv);
      expect(code).not.toBe(0);
      expect(stdout).toBe('');
      expect(stderr).not.toBe('');
    }
  });

  it('AUT-R16 prints one line with an HS256 token for the lowercase sub, issued now and expiring 900 s later', async () => {
    const { code, stdout, stderr } = await run(['--sub', C1.toUpperCase(), '--role', 'customer']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.endsWith('\n')).toBe(true);
    const lines = stdout.split('\n');
    expect(lines).toHaveLength(2);
    const token = lines[0] ?? '';
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const { header, claims } = decodeToken(token);
    expect(header).toStrictEqual({ alg: 'HS256', typ: 'JWT' });
    expect(claims).toStrictEqual({
      sub: C1,
      role: 'customer',
      iat: T,
      exp: T + 900,
      iss: 'scf-test',
      aud: 'scf-api',
    });
    const [encodedHeader, payload, signature] = segments(token);
    expect(signature).toBe(
      createHmac('sha256', K).update(`${encodedHeader}.${payload}`).digest('base64url'),
    );
  });
});
