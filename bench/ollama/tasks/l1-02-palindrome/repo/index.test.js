import test from 'node:test';
import assert from 'node:assert/strict';
import { isPalindrome } from './index.js';
test('palindromes normalisés', () => {
  for (const text of ['', '!!!', 'A', 'Radar', 'A man, a plan, a canal: Panama!', '12 21']) assert.equal(isPalindrome(text), true, text);
  for (const text of ['bonjour', 'ab', '1231', 'Radar2']) assert.equal(isPalindrome(text), false, text);
});
