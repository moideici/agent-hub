import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp } from './index.js';
test('bornes et intérieur', () => {
  for (const [v, min, max, expected] of [[5, 0, 10, 5], [-2, 0, 10, 0], [11, 0, 10, 10], [0, 0, 10, 0], [10, 0, 10, 10], [-3, -8, -2, -3], [1.5, 1, 2, 1.5], [99, 4, 4, 4]]) assert.equal(clamp(v, min, max), expected);
});
