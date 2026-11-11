import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRow } from './index.js';
test('champs simples et cités', () => {
  for (const [row, expected] of [['', ['']], [',', ['', '']], ['a,b,', ['a', 'b', '']], [' a , b', [' a ', ' b']], ['"a,b",c', ['a,b', 'c']], ['"a""b","",z', ['a"b', '', 'z']], ['""""', ['"']], ['" a "', [' a ']]]) assert.deepEqual(parseCsvRow(row), expected, row);
});
test('CSV incorrect refusé', () => {
  for (const row of ['"abc', 'ab"c', ' "x"', '"x" ', '"x"y', '"""', 'a\nb', '"a\rb"']) assert.throws(() => parseCsvRow(row), SyntaxError, row);
  for (const row of [null, 12, [], undefined]) assert.throws(() => parseCsvRow(row), TypeError);
});
