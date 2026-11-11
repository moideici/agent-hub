import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate as e } from './expression.js';

test('nombres, espaces, parenthèses et associativité', () => {
  for (const [source, value] of [
    [' 1. + .5 + 1e-2 + 2E+1\n', 21.51], ['2+3*4', 14], ['(2+3)*4', 20],
    ['10-3-2', 5], ['24/4/2', 3], ['17%5*2', 4], ['2^3^2', 512],
    ['-2^2', -4], ['(-2)^2', 4], ['2^-2', .25], ['--3', 3], ['2*-3', -6], ['+2', 2],
  ]) assert.equal(e(source), value, source);
});
test('comparaisons, logique numérique et priorités', () => {
  for (const [source, value] of [
    ['2+3*2>=8 == 1', 1], ['3<2<1', 1], ['2==2!=0', 1], ['3<=3', 1], ['4>4', 0],
    ['!0 + !8', 1], ['2&&3', 1], ['0||-4', 1], ['0||2&&0', 0], ['!2^0', 0],
    ['1 ? 0 ? 4 : 5 : 6', 5], ['0 ? 1 : 0 ? 2 : 3', 3], ['0||1 ? 7 : 8', 7],
  ]) assert.equal(e(source), value, source);
});
test('variables propres et absence de mutation', () => {
  const vars = Object.freeze(Object.assign(Object.create({ inherited: 4 }), { price: 8, _tax2: .5, constructor: 3 }));
  assert.equal(e('price * (1 + _tax2) + constructor', vars), 15);
  assert.throws(() => e('inherited', vars), { name: 'ReferenceError', message: 'unknown inherited at 0' });
  assert.throws(() => e('1 + missing'), { name: 'ReferenceError', message: 'unknown missing at 4' });
  assert.throws(() => e('toString'), ReferenceError);
});
test('les branches inutiles ne sont pas évaluées', () => {
  for (const [source, value] of [
    ['0 && missing', 0], ['3 || 1/0', 1], ['1 ? 9 : missing', 9], ['0 ? 1%0 : 4', 4],
    ['0 && 1/0 || 5', 1], ['0 ? unknown : 1 ? 12 : 1/0', 12],
  ]) assert.equal(e(source), value);
  assert.throws(() => e('1 && missing'), ReferenceError);
  assert.throws(() => e('0 || 1/0'), { name: 'RangeError', message: 'division by zero at 6' });
  assert.throws(() => e('3 % (2-2)'), { name: 'RangeError', message: 'division by zero at 2' });
});
test('diagnostics syntaxiques y compris dans les branches mortes', () => {
  for (const [source, pos] of [
    ['', 0], ['   ', 3], ['1 +', 3], ['(1+2', 4], ['1 2', 2], ['1)', 1],
    ['2**3', 2], ['1 ? 2', 5], ['1 ? : 3', 4], ['0 && (2 + )', 10], ['1 ? 2 : @', 8],
    ['1 = 2', 2], ['.e2', 0], ['1e', 1], ['a.b', 1],
  ]) assert.throws(() => e(source), { name: 'SyntaxError', message: `syntax at ${pos}` }, source);
  assert.throws(() => e('missing + )'), { name: 'SyntaxError', message: 'syntax at 10' });
});
