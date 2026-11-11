import test from 'node:test';
import assert from 'node:assert/strict';
import { successMessage } from './index.js';
test('message de succès', () => { assert.equal(successMessage(), 'Enregistrement terminé'); });
