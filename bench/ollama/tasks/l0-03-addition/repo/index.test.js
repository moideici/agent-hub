import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './index.js';
test('addition', () => {
  for (const [a, b, expected] of [[2, 3, 5], [-5, 2, -3], [0, 7, 7], [0.5, 0.25, 0.75]]) assert.equal(add(a, b), expected);
});
