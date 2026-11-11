import test from 'node:test';
import assert from 'node:assert/strict';
import { totalCart } from './index.js';
test('total et absence de mutation', () => {
  assert.equal(totalCart([]), 0);
  const items = Object.freeze([Object.freeze({ price: 2.5, quantity: 3 }), Object.freeze({ price: -1, quantity: 2 }), Object.freeze({ price: 100, quantity: 0 })]);
  assert.equal(totalCart(items), 5.5);
  assert.equal(totalCart([{ price: 7, quantity: 4 }]), 28);
  assert.equal(totalCart(items), 5.5);
});
