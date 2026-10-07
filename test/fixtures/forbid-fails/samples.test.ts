import { describe, it, test } from 'vitest';

const failingBody = (): never => {
  throw new Error('the body fails, so a fails test would pass');
};

it.fails('fails modifier', failingBody);
it('fails option', { fails: true }, failingBody);
describe('suite with a fails option', { fails: true }, () => {
  it('child', failingBody);
});
const extended = test.extend({});
extended.fails('extended test with fails', failingBody);
it.skipIf(false).fails('chained fails', failingBody);
it('an ordinary passing test', () => undefined);
