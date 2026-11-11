import test from 'node:test';
import assert from 'node:assert/strict';
import { LRUCache } from './cache.js';

test('lecture, remplacement et éviction suivent la récence', () => {
  const c = new LRUCache(2);
  assert.equal(c.set('a', 1).set('b', 2), c);
  assert.equal(c.get('a'), 1);
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.deepEqual(c.entries(), [['a', 1], ['c', 3]]);
  c.set('a', 4).set('d', 5);
  assert.deepEqual(c.entries(), [['a', 4], ['d', 5]]);
  assert.equal(c.size, 2);
});

test('has et les lectures absentes ne touchent pas la récence', () => {
  const c = new LRUCache(2).set('a', 1).set('b', 2);
  assert.equal(c.has('a'), true);
  assert.equal(c.get('absent'), undefined);
  c.set('c', 3);
  assert.equal(c.has('a'), false);
  assert.equal(c.delete('b'), true);
  assert.equal(c.delete('b'), false);
  assert.equal(c.size, 1);
});

test('clés Map, valeurs undefined et instantanés indépendants', () => {
  const key = Object.freeze({ id: 1 });
  const value = Object.freeze({ payload: 2 });
  const c = new LRUCache(3).set(key, value).set(NaN, undefined).set(undefined, 0);
  assert.equal(c.get(key), value);
  assert.equal(c.has(NaN), true);
  assert.equal(c.get(NaN), undefined);
  c.set('x', false);
  assert.equal(c.has(undefined), false);
  const snapshot = c.entries();
  snapshot[0][1] = 'changé';
  snapshot.pop();
  assert.equal(c.get(key), value);
  assert.equal(c.size, 3);
});

test('redimensionnement, zéro, validation sans effet partiel', () => {
  const c = new LRUCache(3).set('a', 1).set('b', 2).set('c', 3);
  c.get('a');
  assert.equal(c.resize(1), c);
  assert.deepEqual(c.entries(), [['a', 1]]);
  for (const n of [-1, 1.5, NaN, Infinity, '2', null]) {
    assert.throws(() => new LRUCache(n), RangeError);
    assert.throws(() => c.resize(n), RangeError);
    assert.deepEqual(c.entries(), [['a', 1]]);
  }
  c.resize(0).set('x', 9);
  assert.equal(c.size, 0);
  c.resize(2).set('x', 8).set('y', 7);
  assert.deepEqual(c.entries(), [['x', 8], ['y', 7]]);
  assert.equal(new LRUCache(0).set('a', 1).has('a'), false);
});
