import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTicket } from './normalize.js';
import { createStore } from './store.js';
import { createService } from './service.js';
test('normalisation et trajet complet', () => {
  const s=createService(createStore());
  const raw={id:' x ',title:' Test ',tags:[' Bug ','','BUG',' Urgent ','urgent','ÉTÉ']}; const copy=structuredClone(raw);
  const expected={id:'x',title:'Test',status:'open',tags:['bug','urgent','été']};
  assert.deepEqual(normalizeTicket(raw),expected);
  assert.deepEqual(s.create(raw),expected); assert.deepEqual(s.find('x'),expected); assert.deepEqual(raw,copy);
  assert.deepEqual(s.create({id:'y',title:'Y',status:'closed'}),{id:'y',title:'Y',status:'closed',tags:[]});
  assert.equal(s.find('absent'),null);
});
test('isolation des tableaux aux frontières', () => {
  const store=createStore(); const ticket={id:'a',title:'A',status:'open',tags:['one']};
  const saved=store.save(ticket); ticket.tags.push('outside'); saved.tags.push('returned');
  assert.deepEqual(store.get('a').tags,['one']);
  const read=store.get('a'); read.tags.length=0; assert.deepEqual(store.get('a').tags,['one']);
  const service=createService(store); const raw={id:'b',title:'B',tags:['Two']};
  const created=service.create(raw); raw.tags.push('outside'); created.tags.push('changed');
  const found=service.find('b'); assert.deepEqual(found.tags,['two']); found.tags.push('changed');
  assert.deepEqual(service.find('b').tags,['two']);
});
test('validations et échec sans sauvegarde', () => {
  const s=createService(createStore());
  for (const tags of [null,'a',{},[1],['ok',null]]) assert.throws(()=>s.create({id:'bad',title:'X',tags}),TypeError);
  assert.equal(s.find('bad'),null);
  for (const raw of [{id:'',title:'X'},{id:'a',title:' '},{id:1,title:'X'}]) assert.throws(()=>normalizeTicket(raw),TypeError);
});
