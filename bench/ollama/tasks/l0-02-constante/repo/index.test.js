import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTES_PER_HOUR } from './index.js';
test('une heure vaut soixante minutes', () => { assert.equal(MINUTES_PER_HOUR, 60); });
