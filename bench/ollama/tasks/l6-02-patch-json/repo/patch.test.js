import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch as patch } from './patch.js';
const op = (op, path, value) => ({ op, path, value });
const transfer = (op, from, path) => ({ op, from, path });
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function invalid(doc, operations, index = 0) {
  const before = structuredClone(doc), ops = structuredClone(operations);
  assert.throws(() => patch(doc, operations), error => error instanceof Error && error.name === 'PatchError' && error.index === index);
  assert.deepEqual(doc, before); assert.deepEqual(operations, ops);
}

test('application séquentielle, insertion et remplacement sans mutation', () => {
  const doc = freeze({ a: [1, 2], b: { old: true } });
  const operations = freeze([op('add', '/a/1', 9), op('replace', '/b/old', false), op('remove', '/a/0'), op('add', '/a/-', 3), op('add', '/b/new', { x: 1 })]);
  assert.deepEqual(patch(doc, operations), { a: [9, 2, 3], b: { old: false, new: { x: 1 } } });
});
test('pointeurs échappés, clés vides, __proto__ et décodage non récursif', () => {
  const doc = JSON.parse('{"a/b":{"~key":1},"":{"":2},"~1":3}');
  const result = patch(doc, [op('replace', '/a~1b/~0key', 4), op('replace', '//', 5), op('replace', '/~01', 6), op('add', '/__proto__', { safe: 7 })]);
  assert.equal(result['a/b']['~key'], 4);
  assert.equal(result[''][''], 5); assert.equal(result['~1'], 6);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.deepEqual(result.__proto__, { safe: 7 });
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  invalid({}, [op('replace', '/toString', 1)]);
  invalid({}, [op('add', '/__proto__/polluted', true)]);
});
test('racines et copie détachée, même sans opérations', () => {
  assert.deepEqual(patch(1, [op('replace', '', [1]), op('add', '/-', 2)]), [1, 2]);
  assert.equal(patch({ x: 1 }, [op('remove', '')]), null);
  assert.deepEqual(patch(null, [op('add', '', { a: 1 })]), { a: 1 });
  const doc = { nested: { x: 1 } }, value = { list: [2] };
  const result = patch(doc, [op('add', '/new', value)]);
  result.nested.x = 9; result.new.list.push(3);
  assert.deepEqual(doc, { nested: { x: 1 } }); assert.deepEqual(value, { list: [2] });
  const copy = patch(doc, []); copy.nested.x = 4;
  assert.equal(doc.nested.x, 1);
});
test('move utilise le document après retrait et copy ne partage pas de référence', () => {
  assert.deepEqual(patch(['a', 'b', 'c', 'd'], [transfer('move', '/1', '/3')]), ['a', 'c', 'd', 'b']);
  assert.deepEqual(patch(['a', 'b', 'c'], [transfer('move', '/0', '/-')]), ['b', 'c', 'a']);
  assert.deepEqual(patch({ a: { x: 1 } }, [transfer('copy', '/a', '/b'), op('replace', '/b/x', 8)]), { a: { x: 1 }, b: { x: 8 } });
  assert.deepEqual(patch({ a: 1, ab: {} }, [transfer('move', '/a', '/ab/x')]), { ab: { x: 1 } });
  assert.deepEqual(patch({ a: { x: 2 } }, [transfer('move', '/a', '')]), { x: 2 });
  assert.deepEqual(patch({ a: [1] }, [transfer('move', '/a', '/a')]), { a: [1] });
  assert.deepEqual(patch({ x: 1 }, [transfer('copy', '', '/snapshot')]), { x: 1, snapshot: { x: 1 } });
  invalid({ a: {} }, [transfer('move', '/a', '/a/child')]);
  invalid({ 'a/b': {} }, [transfer('move', '/a~1b', '/a~1b/x')]);
  invalid({ a: {} }, [transfer('move', '', '/x')]);
  invalid({}, [transfer('move', '/absent', '/absent')]);
});
test('test compare profondément objets et tableaux', () => {
  const doc = { a: [1, { x: 2, y: 3 }], n: null };
  assert.deepEqual(patch(doc, [op('test', '', { n: null, a: [1, { y: 3, x: 2 }] })]), doc);
  for (const value of [{ a: [1, { x: 2 }] }, { a: [1, { x: 2, y: 3 }], n: 0 }, [1], '1']) invalid(doc, [op('test', '', value)]);
  invalid([1, 2], [op('test', '', [2, 1])]);
  invalid({}, [op('test', '/missing', null)]);
});
test('indices et chemins invalides, rollback après plusieurs opérations', () => {
  for (const path of ['a', '/~2', '/~', '/a/~3']) invalid({}, [op('add', path, 1)]);
  for (const path of ['/01', '/-1', '/1.0', '/2', '/9007199254740992']) invalid([0], [op('add', path, 1)]);
  for (const kind of ['remove', 'replace', 'test']) invalid([0], [op(kind, '/-', 1)]);
  invalid({ a: 2 }, [op('add', '/a/b', 1)]);
  invalid({}, [op('add', '/missing/child', 1)]);
  invalid({}, [op('unknown', '', 1)]);
  invalid({ a: [1, 2] }, [op('add', '/a/-', 3), transfer('move', '/a/0', '/a/9')], 1);
  invalid({ a: 1 }, [op('replace', '/a', 2), op('test', '/a', 1)], 1);
  assert.deepEqual(patch([], [op('add', '/0', 1)]), [1]);
});
