import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_PER_SECOND, loadParameters } from '../../../scripts/load-test.js';

describe('the load test parameters', () => {
  it('SYS-R20 runs at LOAD_RATE_PER_SECOND, 200 when unset or empty, for 60 s over 1000 pairs', () => {
    expect(DEFAULT_RATE_PER_SECOND).toBe(200);
    expect(loadParameters({})).toMatchObject({
      ratePerSecond: 200,
      durationSeconds: 60,
      pairs: 1000,
    });
    expect(loadParameters({ LOAD_RATE_PER_SECOND: '' }).ratePerSecond).toBe(200);
    expect(loadParameters({ LOAD_RATE_PER_SECOND: '100' }).ratePerSecond).toBe(100);
    expect(loadParameters({ LOAD_RATE_PER_SECOND: '500' }).ratePerSecond).toBe(500);
  });

  it('SYS-R20 refuses a rate that is not a whole number from 1 to 500, naming the variable', () => {
    for (const value of ['0', '501', '-1', '1.5', '100 ', '0100', 'abc']) {
      expect(() => loadParameters({ LOAD_RATE_PER_SECOND: value }), value).toThrow(
        'LOAD_RATE_PER_SECOND',
      );
    }
  });
});
