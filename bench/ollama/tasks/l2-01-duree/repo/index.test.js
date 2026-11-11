import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from './index.js';
test('durées valides', () => {
  for (const [s, expected] of [['0s', 0], ['1h30m', 5400], ['2h3m4s', 7384], ['90m', 5400], ['15s', 15], ['2h4s', 7204], ['001m02s', 62], ['9007199254740991s', Number.MAX_SAFE_INTEGER]]) assert.equal(parseDuration(s), expected, s);
});
test('formats et débordements refusés', () => {
  for (const s of ['', '1', 'h', '1m1h', '1s1s', '1H', ' 1s', '1s ', '1s\n', '-1s', '+1s', '1.5h', '1h 2m', '1ms', '9007199254740992s', '2501999792984h']) assert.throws(() => parseDuration(s), RangeError, s);
  for (const value of [null, undefined, 1, {}, []]) assert.throws(() => parseDuration(value), TypeError);
});
