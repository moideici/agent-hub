import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './report.js';
import { parseOptions } from './options.js';
import { renderReport } from './render.js';
test('JSON compact fidèle et sans mutation', () => {
  const rows=[{name:'A"\nB',count:0},{name:'été',count:12}]; const copy=structuredClone(rows);
  assert.equal(run(['--json'],rows),JSON.stringify(rows));
  assert.deepEqual(JSON.parse(run(['--json'],rows)),rows);
  assert.equal(run(['--json'],[]),'[]');
  assert.equal(renderReport(rows,'json'),JSON.stringify(rows));
  assert.deepEqual(rows,copy);
});
test('options et régression texte', () => {
  const rows=[{name:'A',count:2},{name:'B',count:0}];
  assert.deepEqual(parseOptions(['--json']),{format:'json'});
  assert.equal(run([],rows),'A: 2\nB: 0');
  assert.equal(run(['--json','--text'],rows),'A: 2\nB: 0');
  assert.equal(run(['--text','--json'],rows),JSON.stringify(rows));
  assert.equal(run([],[]),'');
  assert.throws(()=>run(['--xml'],rows),/option inconnue/);
  assert.throws(()=>renderReport(rows,'xml'),/format inconnu/);
});
