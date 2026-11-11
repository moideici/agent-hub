import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from './plan.js';
const n = (id, ...deps) => Object.freeze({ id, deps: Object.freeze(deps) });

test('priorité à la position initiale, même pour un sommet nouvellement libéré', () => {
  const input = Object.freeze([n('a', 'c'), n('b', 'a'), n('c'), n('d'), n('e', 'd', 'c')]);
  assert.deepEqual(plan(input), { order: ['c', 'a', 'b', 'd', 'e'], blocked: [] });
  assert.deepEqual(plan(input), { order: ['c', 'a', 'b', 'd', 'e'], blocked: [] });
});
test('diamant, doublons et identifiants spéciaux', () => {
  assert.deepEqual(plan([n('end', 'left', 'right', 'left'), n('left', '__proto__'), n('right', '__proto__'), n('__proto__'), n('constructor')]),
    { order: ['__proto__', 'left', 'right', 'end', 'constructor'], blocked: [] });
  assert.deepEqual(plan([]), { order: [], blocked: [] });
});
test('cycles, descendants bloqués et composantes indépendantes', () => {
  assert.deepEqual(plan([n('tail', 'a'), n('a', 'b'), n('b', 'a'), n('self', 'self'), n('free'), n('after', 'free')]),
    { order: ['free', 'after'], blocked: ['tail', 'a', 'b', 'self'] });
});
test('validation déterministe', () => {
  assert.throws(() => plan([n('x', 'absent'), n('x')]), { message: 'duplicate id: x' });
  assert.throws(() => plan([n('x', 'z', 'y'), n('q', 'r')]), { message: 'unknown dependency: z' });
});
test('chaîne inversée et nombreux sommets disponibles', () => {
  const nodes = Array.from({ length: 1000 }, (_, i) => n(String(i), ...(i === 999 ? [] : [String(i + 1)])));
  assert.deepEqual(plan(nodes).order, nodes.map(x => x.id).reverse());
  const independent = Array.from({ length: 511 }, (_, i) => n(String(i)));
  assert.deepEqual(plan(independent), { order: independent.map(x => x.id), blocked: [] });
});
