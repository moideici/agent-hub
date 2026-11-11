import test from 'node:test';
import assert from 'node:assert/strict';
import { initials } from './index.js';
test('initiales', () => {
  for (const [name, expected] of [['', ''], ['   ', ''], ['ada', 'A'], ['Ada Lovelace', 'AL'], ['  jean   paul  sartre ', 'JPS'], ['alan\tturing\nsmith', 'ATS']]) assert.equal(initials(name), expected);
});
