import test from 'node:test';
import assert from 'node:assert/strict';
import { listRecords } from './records.js';
const rows = [{id:4,name:'Delta'},{id:2,name:'Beta'},{id:1,name:'Alpha'},{id:3,name:'Charlie'},{id:5,name:'Echo'}];
test('pagination complète et liens', () => {
  assert.deepEqual([1,2,3,4].map(page => { const r=listRecords(rows,{page}); return [r.items.map(x=>x.id),r.total,r.pages,r.previous,r.next]; }), [ [[1,2],5,3,null,2], [[3,4],5,3,1,3], [[5],5,3,2,null], [[],5,3,3,null] ]);
  assert.deepEqual(listRecords(rows,{size:1,query:'  TA '}).items,[rows[1]]);
  assert.deepEqual(listRecords([{id:2,name:'A'},{id:1,name:'A'}],{size:2}).items.map(x=>x.id),[1,2]);
});
test('filtrage, taille unitaire, tri et absence de mutation', () => {
  const copy=structuredClone(rows);
  assert.deepEqual(listRecords(rows,{size:10,query:'ta'}).items,[rows[1],rows[0]]);
  assert.deepEqual(rows,copy);
});
test('vide et paramètres invalides', () => {
  assert.deepEqual(listRecords([]),{items:[],total:0,pages:0,page:1,previous:null,next:null});
  for (const options of [{page:0},{page:1.5},{size:0},{size:-1}]) assert.throws(()=>listRecords(rows,options),RangeError);
});
