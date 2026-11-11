import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
test('fichier de bienvenue', () => {
  const file = new URL('./welcome.txt', import.meta.url);
  assert.equal(existsSync(file), true, 'welcome.txt doit exister');
  assert.equal(readFileSync(file, 'utf8'), 'Bonjour !\n');
});
