import { describe, expect, it } from 'vitest';
import { secretScrubber } from '../../../src/platform/logging/logger.js';

const SECRETS = {
  jwtSecret: 'jwt-secret-for-the-scrubber-unit-tests-000000000',
  cursorSecret: 'cursor-secret-for-the-scrubber-unit-tests-0000000',
  databaseUrl: 'postgres://scf_app:30@127.0.0.1:55432/supercool_test',
  redisUrl: 'redis://:2026@127.0.0.1:6379',
};

describe('the secret scrubber', () => {
  it('SEC-R21 SEC-R22 replaces secrets inside string values only, so a line stays valid JSON with its keys and numbers', () => {
    const scrub = secretScrubber(SECRETS);
    const line = `${JSON.stringify({
      level: 30,
      time: 1791498618648,
      pid: 2026,
      '30': 'a key that is a password',
      msg: 'connected with 30 and 2026',
      url: SECRETS.databaseUrl,
      nested: { secret: SECRETS.jwtSecret, count: 302026, list: ['x30y', 30] },
    })}\n`;

    const scrubbed = scrub(line);

    expect(scrubbed.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(scrubbed) as Record<string, unknown>;
    expect(parsed).toEqual({
      level: 30,
      time: 1791498618648,
      pid: 2026,
      '30': 'a key that is a password',
      msg: 'connected with [Redacted] and [Redacted]',
      url: 'postgres://scf_app:[Redacted]@127.0.0.1:55432/supercool_test',
      nested: { secret: '[Redacted]', count: 302026, list: ['x[Redacted]y', 30] },
    });
  });

  it('SEC-R22 replaces a secret written with JSON escapes, and leaves a line without strings as it is', () => {
    const quoted = 'pass"word\\with-escapes';
    const scrub = secretScrubber({
      ...SECRETS,
      databaseUrl: `postgres://scf_app:${encodeURIComponent(quoted)}@host/db`,
    });
    const line = JSON.stringify({ level: 50, err: { message: `auth failed for ${quoted}` } });
    expect(JSON.parse(scrub(line))).toEqual({
      level: 50,
      err: { message: 'auth failed for [Redacted]' },
    });
    expect(scrub('{"level":30,"time":2026}')).toBe('{"level":30,"time":2026}');
  });

  it('SEC-R22 replaces SENTRY_DSN and its public key, wherever a string value holds them', () => {
    const dsn = 'https://pk-scrub-7781@errors.example/42';
    const scrub = secretScrubber({ ...SECRETS, sentryDsn: dsn });
    const line = `${JSON.stringify({ msg: 'reporting', dsn, key: 'pk-scrub-7781' })}\n`;

    const parsed = JSON.parse(scrub(line)) as Record<string, unknown>;

    expect(parsed).toEqual({ msg: 'reporting', dsn: '[Redacted]', key: '[Redacted]' });
  });
});
