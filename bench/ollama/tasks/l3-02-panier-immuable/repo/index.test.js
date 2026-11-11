import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBasket, addProduct, removeProduct, basketLabel } from './basket.js';
const catalog=[{sku:'a',price:120},{sku:'b',price:50}];
test('historique après ajouts répétés', () => {
  const first=addProduct(emptyBasket(),catalog,'a');
  const snapshot=structuredClone(first);
  const second=addProduct(first,[{sku:'a',price:999}],'a',2);
  assert.deepEqual(first,snapshot);
  assert.deepEqual(second,{lines:[{sku:'a',price:120,quantity:3}],total:360,count:3});
  const third=addProduct(second,catalog,'b',2);
  assert.equal(third.total,460);
  assert.equal(second.count,3);
  assert.deepEqual(catalog,[{sku:'a',price:120},{sku:'b',price:50}]);
  Object.freeze(first.lines[0]); Object.freeze(first.lines); Object.freeze(first);
  assert.equal(addProduct(first,catalog,'a').count,2);
});
test('entrées gelées et suppression', () => {
  const first=addProduct(emptyBasket(),catalog,'a');
  Object.freeze(first.lines[0]); Object.freeze(first.lines); Object.freeze(first);
  assert.deepEqual(removeProduct(first,'a'),emptyBasket());
  assert.equal(removeProduct(first,'absent').total,120);
  assert.equal(basketLabel(first),'1 article');
  assert.equal(basketLabel(emptyBasket()),'0 articles');
});
test('validations', () => {
  for (const q of [0,-1,1.5]) assert.throws(()=>addProduct(emptyBasket(),catalog,'a',q),RangeError);
  assert.throws(()=>addProduct(emptyBasket(),catalog,'x'),/produit inconnu/);
  assert.throws(()=>addProduct(emptyBasket(),[{sku:'a',price:-2}],'a'),RangeError);
});
