import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './index.js';
test('double est public et conserve son calcul', () => {
  assert.equal(typeof api.double, 'function');
  assert.equal(api.double(3), 6);
  assert.equal(api.double(-4), -8);
  assert.equal(api.double(0), 0);
});
