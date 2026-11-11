import test from 'node:test';
import assert from 'node:assert/strict';
import { shortestPath as route } from './route.js';

test('direction, coûts et relaxation d’un chemin déjà découvert', () => {
  const edges = Object.freeze([['s', 't', 20], ['s', 'a', 8], ['s', 'b', 1], ['b', 'a', 2], ['a', 't', 1]].map(Object.freeze));
  assert.deepEqual(route(edges, 's', 't'), { distance: 4, path: ['s', 'b', 'a', 't'] });
  assert.equal(route(edges, 't', 's'), null);
  assert.equal(route(edges, 's', 'isolé'), null);
  assert.deepEqual(route([], '', ''), { distance: 0, path: [''] });
});
test('départage par nombre d’arêtes puis chemin entier', () => {
  assert.deepEqual(route([['s', 'a', 0], ['a', 't', 2], ['s', 't', 2]], 's', 't'), { distance: 2, path: ['s', 't'] });
  const edges = [['s', 'b', 0], ['b', 'a', 0], ['a', 't', 1], ['s', 'A', 0], ['A', 'z', 0], ['z', 't', 1]];
  assert.deepEqual(route(edges, 's', 't'), { distance: 1, path: ['s', 'A', 'z', 't'] });
  assert.deepEqual(route([...edges].reverse(), 's', 't'), { distance: 1, path: ['s', 'A', 'z', 't'] });
});
test('cycles nuls, boucles, arêtes parallèles et clés spéciales', () => {
  assert.deepEqual(route([['s', 's', 0], ['s', 'a', 9], ['s', 'a', 0], ['a', 's', 0], ['a', '__proto__', 3]], 's', '__proto__'),
    { distance: 3, path: ['s', 'a', '__proto__'] });
  assert.deepEqual(route([['s', 't', 0.5]], 's', 't'), { distance: 0.5, path: ['s', 't'] });
});
test('valide aussi les arêtes inaccessibles avant tout retour', () => {
  for (const cost of [-1, NaN, Infinity, '1', null]) {
    assert.throws(() => route([['x', 'y', cost]], 's', 's'), RangeError);
  }
});
test('graphe à de nombreux chemins concurrents', () => {
  const edges = [];
  for (let i = 0; i < 22; i++) {
    for (const a of ['a', 'b']) for (const b of ['a', 'b']) edges.push([`${i}${a}`, `${i + 1}${b}`, 1]);
  }
  assert.deepEqual(route(edges, '0a', '22b'), { distance: 22, path: [...Array.from({ length: 22 }, (_, i) => `${i}a`), '22b'] });
});
