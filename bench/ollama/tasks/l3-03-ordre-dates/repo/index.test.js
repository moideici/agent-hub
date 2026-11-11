import test from 'node:test';
import assert from 'node:assert/strict';
import { timeline, eventLabel } from './events.js';
const range={from:'2025-01-01T00:00:00Z',to:'2025-01-02T00:00:00Z'};
test('décalages et égalités', () => {
  const events=[{id:'z',kind:'read',at:'2025-01-01T08:00:00Z'},{id:'b',kind:'write',at:'2025-01-01T10:00:00+02:00'},{id:'c',kind:'read',at:'2025-01-01T07:30:00-01:00'},{id:'a',kind:'read',at:'2025-01-01T08:00:00Z'}];
  const copy=structuredClone(events);
  const result=timeline(events,range);
  assert.deepEqual(result.items.map(x=>x.id),['a','b','z','c']);
  assert.deepEqual([result.count,result.byKind,result.firstId,result.lastId],[4,{read:3,write:1},'a','c']);
  assert.deepEqual(timeline(events,{...range,kind:'write'}).items,[events[1]]);
  assert.deepEqual(events,copy);
});
test('bornes, vide et erreurs', () => {
  const events=[{id:'start',kind:'x',at:range.from},{id:'end',kind:'x',at:range.to}];
  assert.deepEqual(timeline(events,range).items,[events[0]]);
  assert.deepEqual(timeline([],{from:range.from,to:range.from}),{items:[],count:0,byKind:{},firstId:null,lastId:null});
  assert.throws(()=>timeline([],{from:range.to,to:range.from}),RangeError);
  assert.throws(()=>timeline([{id:'x',at:'oops'}],range),RangeError);
  assert.throws(()=>timeline([],{...range,from:'oops'}),RangeError);
  assert.equal(eventLabel(events[0]),'x:start');
});
