import test from 'node:test';
import assert from 'node:assert/strict';
import { invoice, formatCents } from './invoice.js';
test('arrondis par ligne, vers le haut et vers le bas', () => {
  for (const [price,expected] of [[3,2],[2,0]]) {
    const source=[{label:'A',price,quantity:1,taxRate:20},{label:'B',price,quantity:1,taxRate:20}];
    const copy=structuredClone(source); const result=invoice(source);
    assert.equal(result.tax,expected);
    assert.equal(result.gross,price*2+expected);
    assert.equal(result.tax,result.lines.reduce((s,x)=>s+x.tax,0));
    assert.deepEqual(source,copy);
  }
});
test('quantités, demi-centime, taux diffèrents et facture vide', () => {
  assert.deepEqual(invoice([{label:'A',price:5,quantity:3,taxRate:10},{label:'B',price:100,quantity:2,taxRate:0}]),{lines:[{label:'A',net:15,tax:2,gross:17},{label:'B',net:200,tax:0,gross:200}],net:215,tax:2,gross:217});
  assert.deepEqual(invoice([]),{lines:[],net:0,tax:0,gross:0});
  assert.equal(formatCents(1203),'12,03 €'); assert.equal(formatCents(0),'0,00 €');
});
test('validations conservées', () => {
  for (const patch of [{price:-1},{price:1.1},{quantity:0},{quantity:1.5},{taxRate:101},{taxRate:-1}]) assert.throws(()=>invoice([{label:'X',price:10,quantity:1,taxRate:20,...patch}]),RangeError);
  assert.throws(()=>formatCents(-1),RangeError);
});
