import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from './index.js';
test('nom public corrigé', () => {
  assert.equal(typeof api.greet, 'function');
  assert.equal(api.greet('Ada'), 'Bonjour Ada');
  assert.equal(api.greet('Bob'), 'Bonjour Bob');
  assert.equal(Object.hasOwn(api, 'grete'), false);
});
