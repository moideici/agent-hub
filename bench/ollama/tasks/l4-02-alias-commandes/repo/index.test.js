import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from './registry.js';
import { loadCommands } from './loader.js';
import { dispatch } from './dispatch.js';
test('alias chargés, arguments et retour', () => {
  const handler=args=>args.join('/');
  const r=loadCommands([{name:'list',aliases:['ls','l'],run:handler},{name:'help',run:()=>42}]);
  assert.deepEqual(r.names(),['help','l','list','ls']);
  for (const name of ['list','ls','l']) { assert.equal(r.resolve(name),handler); assert.equal(dispatch(r,name,['a','b']),'a/b'); }
  assert.equal(dispatch(r,'help'),42);
  assert.throws(()=>dispatch(r,'absent'),/commande inconnue/);
});
test('collisions atomiques dans les deux sens', () => {
  const r=createRegistry(); const h=()=>1; r.register('first',h,['f']);
  for (const [name,aliases] of [['other',['fresh','f']],['f',[]],['third',['first']],['dup',['x','x']],['self',['self']]]) {
    assert.throws(()=>r.register(name,h,aliases),/nom déjà pris/);
    assert.deepEqual(r.names(),['f','first']);
  }
  assert.equal(r.resolve('f'),h);
  assert.throws(()=>r.register('bad',null,['b']),TypeError);
  assert.deepEqual(r.names(),['f','first']);
  r.register('next',h,['n']); assert.deepEqual(r.names(),['f','first','n','next']);
});
