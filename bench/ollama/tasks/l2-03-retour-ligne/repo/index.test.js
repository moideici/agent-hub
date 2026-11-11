import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from './index.js';
test('repli et normalisation', () => {
  assert.deepEqual(wrapText('', 5), []);
  assert.deepEqual(wrapText(' \t\n ', 5), []);
  assert.deepEqual(wrapText('un deux trois', 7), ['un deux', 'trois']);
  assert.deepEqual(wrapText(' un  deux\ntrois\tquatre ', 8), ['un deux', 'trois', 'quatre']);
  assert.deepEqual(wrapText('a abcdef b c', 3), ['a', 'abcdef', 'b c']);
  assert.deepEqual(wrapText('a b c', 1), ['a', 'b', 'c']);
  assert.deepEqual(wrapText('abc def', 7), ['abc def']);
  assert.deepEqual(wrapText('seul', 99), ['seul']);
});
test('arguments invalides', () => {
  for (const width of [0, -1, 2.5, NaN, Infinity, '5', null, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => wrapText('', width), RangeError);
  for (const text of [null, [], 42, undefined]) assert.throws(() => wrapText(text, 5), TypeError);
});
