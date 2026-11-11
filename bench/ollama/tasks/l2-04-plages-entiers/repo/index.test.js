import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRanges } from './index.js';
test('développement trié et unique', () => {
  for (const [text, expected] of [['', []], ['   ', []], ['3,1-2,2', [1,2,3]], [' 10, 2 , 0-1 ', [0,1,2,10]], ['4-4,004,02', [2,4]], ['998-1000', [998,999,1000]], ['0', [0]]]) assert.deepEqual(expandRanges(text), expected, text);
  assert.equal(expandRanges('0-1000').length, 1001);
});
test('sélections invalides', () => {
  for (const text of [',', '1,', ',1', '1,,2', '-1', '2-1', '1001', '999-1001', '1 -2', '1- 2', '1.5', '+1', '1e2', '1-2-3', 'a', '1\n', '\t1', '1\t']) assert.throws(() => expandRanges(text), RangeError, text);
  for (const text of [null, 1, [], undefined]) assert.throws(() => expandRanges(text), TypeError);
});
