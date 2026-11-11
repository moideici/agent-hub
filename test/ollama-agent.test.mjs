import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOllama, parseInlineToolCalls } from '../lib/ollama.mjs';
import { normalizeLocal } from '../lib/config.mjs';
import { startFakeOllama, call, say } from './fake-ollama.mjs';

// Tous les faux serveurs sont fermés à la fin, même quand une assertion échoue (sinon le processus de test ne se termine pas).
const open = [];
const start = async (...a) => {
  const s = await startFakeOllama(...a);
  open.push(s);
  return s;
};
after(() => Promise.all(open.map((s) => s.close())));

/** Mini projet Node avec un test qui échoue tant que add() est faux. */
function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ollama-'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'math.js'), 'export function add(a, b) {\n  return a - b;\n}\n');
  fs.writeFileSync(path.join(dir, 'test', 'math.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  return dir;
}

const acctFor = (host, over = {}) => normalizeLocal({ name: 'fake', model: 'fake:1b', host, ...over });
const run = (srv, dir, over = {}, extra = {}) => runOllama({ account: acctFor(srv.host, over), cwd: dir, prompt: '# Task\n\nCorrige add.', testCmd: 'npm test', timeoutMs: 60_000, ...extra });
const toolResults = (srv) => srv.requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('agent : lit, corrige, lance les tests puis termine ; événements compatibles Codex', async () => {
  const dir = project();
  const srv = await start({ script: [
    say('', call('list_files')),
    say('', call('read_file', { path: 'math.js' })),
    say('', call('replace_in_file', { path: 'math.js', old_text: 'return a - b;', new_text: 'return a + b;' })),
    say('', call('run_tests')),
    say('', call('finish', { summary: 'add corrigée, tests OK' })),
  ] });
  const events = [];
  const r = await run(srv, dir, {}, { onEvent: (e) => events.push(e) });
  assert.equal(r.code, 0);
  assert.equal(r.finalMessage, 'add corrigée, tests OK');
  assert.match(fs.readFileSync(path.join(dir, 'math.js'), 'utf8'), /return a \+ b;/);
  assert.equal(r.stats.toolCalls, 5);
  assert.equal(r.stats.writes, 1);
  assert.equal(r.stats.tests, 1);
  assert.equal(r.stats.toolErrors, 0);
  assert.equal(r.usage.output_tokens, 100); // 5 réponses x 20 jetons
  assert.equal(r.stats.tokPerSec, 20); // 100 jetons / 5 s
  assert.match(toolResults(srv).find((t) => t.startsWith('exit code')), /^exit code 0/);
  assert.ok(events.some((e) => e.item?.type === 'command_execution' && e.item.command === 'read_file math.js'));
  assert.ok(events.some((e) => e.item?.type === 'file_change' && /math\.js$/.test(e.item.changes[0].path)));
  assert.ok(events.some((e) => e.item?.type === 'agent_message'));
  // le prompt système et les outils sont bien envoyés, avec les réglages du modèle
  const first = srv.requests[0];
  assert.equal(first.model, 'fake:1b');
  assert.equal(first.stream, false);
  assert.equal(first.options.num_ctx, 32768);
  assert.deepEqual(first.tools.map((t) => t.function.name), ['list_files', 'read_file', 'search', 'write_file', 'replace_in_file', 'run_tests', 'ask_question', 'finish']);
  await srv.close();
});

test('agent : les chemins sont confinés au projet et les zones sensibles protégées', async () => {
  const dir = project();
  const outside = path.join(os.tmpdir(), `evil-${Date.now()}.txt`);
  const srv = await start({ script: [
    say('', call('write_file', { path: '../evil.txt', content: 'x' })),
    say('', call('write_file', { path: outside, content: 'x' })),
    say('', call('write_file', { path: '.git/config', content: 'x' })),
    say('', call('write_file', { path: 'node_modules/x.js', content: 'x' })),
    say('', call('write_file', { path: '.env', content: 'SECRET=1' })),
    say('', call('read_file', { path: '../../etc/passwd' })),
    say('', call('write_file', { path: 'test/math.test.js', content: '// triche' })),
    say('', call('replace_in_file', { path: 'test/math.test.js', old_text: 'add(2, 3), 5', new_text: 'add(2, 3), -1' })),
    say('', call('write_file', { path: 'test/nouveau.test.js', content: "import test from 'node:test';\ntest('ok', () => {});\n" })),
    say('', call('finish', { summary: 'fini' })),
  ] });
  const r = await run(srv, dir);
  const res = toolResults(srv);
  assert.match(res[0], /outside the project/);
  assert.match(res[1], /outside the project/);
  assert.match(res[2], /not allowed/);
  assert.match(res[3], /not allowed/);
  assert.match(res[4], /not allowed/);
  assert.match(res[5], /outside the project/);
  assert.match(res[6], /existing test file: it is read-only/);
  assert.match(res[7], /existing test file/);
  assert.match(res[8], /created test\/nouveau\.test\.js/); // créer un NOUVEAU test reste permis
  assert.equal(r.stats.toolErrors, 8);
  assert.equal(r.stats.testFilesEdited, true); // signalé : l'agent a essayé de toucher aux tests
  assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')) && !fs.existsSync(outside));
  assert.ok(!fs.existsSync(path.join(dir, '.env')) && !fs.existsSync(path.join(dir, '.git')));
  assert.match(fs.readFileSync(path.join(dir, 'test', 'math.test.js'), 'utf8'), /assert\.equal\(add\(2, 3\), 5\)/); // test intact
  await srv.close();
});

test('replace_in_file : texte absent, ambigu, et fins de ligne CRLF conservées', async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'dup.js'), 'const a = 1;\r\nconst b = 1;\r\n');
  const srv = await start({ script: [
    say('', call('replace_in_file', { path: 'math.js', old_text: 'return a * b;', new_text: 'x' })),
    say('', call('replace_in_file', { path: 'dup.js', old_text: ' = 1;', new_text: ' = 2;' })),
    say('', call('replace_in_file', { path: 'dup.js', old_text: 'const b = 1;', new_text: 'const b = 9;' })),
    say('', call('replace_in_file', { path: 'inexistant.js', old_text: 'a', new_text: 'b' })),
    say('', call('finish', { summary: 'ok' })),
  ] });
  await run(srv, dir);
  const res = toolResults(srv);
  assert.match(res[0], /was not found/);
  assert.match(res[1], /appears 2 times/);
  assert.match(res[2], /replaced in dup\.js at line 2/);
  assert.match(res[3], /does not exist/);
  assert.equal(fs.readFileSync(path.join(dir, 'dup.js'), 'utf8'), 'const a = 1;\r\nconst b = 9;\r\n');
  await srv.close();
});

test('agent : un modèle qui parle au lieu d’agir est relancé puis son texte sert de résumé', async () => {
  const dir = project();
  const srv = await start({ script: [say('Je réfléchis…'), say('Toujours…'), say('Voici ma réponse finale.')] });
  const r = await run(srv, dir);
  assert.equal(r.code, 0);
  assert.equal(r.finalMessage, 'Voici ma réponse finale.');
  assert.equal(r.stats.nudges, 3);
  assert.match(srv.requests[1].messages.at(-1).content, /Reply with a tool call/);
  await srv.close();
});

test('agent : appel d’outil écrit dans le texte (balises ou bloc json) accepté', async () => {
  assert.deepEqual(parseInlineToolCalls('<tool_call>{"name":"finish","arguments":{"summary":"ok"}}</tool_call>', ['finish']), [{ function: { name: 'finish', arguments: { summary: 'ok' } } }]);
  assert.equal(parseInlineToolCalls('```json\n{"name":"read_file","arguments":{"path":"a"}}\n```', ['read_file']).length, 1);
  assert.equal(parseInlineToolCalls('{"name":"inconnu","arguments":{}}', ['finish']).length, 0);
  assert.equal(parseInlineToolCalls('du texte {pas du json', ['finish']).length, 0);
  const dir = project();
  const srv = await start({ script: [say('<tool_call>{"name":"finish","arguments":{"summary":"via balises"}}</tool_call>')] });
  assert.equal((await run(srv, dir)).finalMessage, 'via balises');
  await srv.close();
});

test('agent : ask_question termine par une QUESTION', async () => {
  const srv = await start({ script: [say('', call('ask_question', { question: 'Quel format de date ?' }))] });
  const r = await run(srv, project());
  assert.equal(r.finalMessage, 'QUESTION: Quel format de date ?');
  assert.equal(r.code, 0);
  await srv.close();
});

test('agent : modèle introuvable et Ollama arrêté donnent un message clair (code 1)', async () => {
  const srv = await start({ models: ['autre:7b'] });
  const missing = await run(srv, project());
  assert.equal(missing.code, 1);
  assert.match(missing.errors[0], /modèle "fake:1b" introuvable.*autre:7b.*ah ollama setup/);
  await srv.close();
  const down = await run(srv, project());
  assert.equal(down.code, 1);
  assert.match(down.errors[0], /Ollama injoignable/);
});

test('agent : boucle détectée, limite d’étapes et délai dépassé', async () => {
  const same = Array.from({ length: 10 }, () => say('', call('read_file', { path: 'math.js' })));
  const s1 = await start({ script: same });
  const loop = await run(s1, project());
  assert.match(loop.errors[0], /boucle détectée/);
  assert.match(toolResults(s1)[2], /already made this exact call/);
  await s1.close();

  const s2 = await start({ script: Array.from({ length: 10 }, (_, i) => say('', call('search', { pattern: `x${i}` }))) });
  const lim = await run(s2, project(), { maxSteps: 3 });
  assert.equal(lim.limitReached, true);
  assert.match(lim.finalMessage, /Limite de 3 étapes/);
  assert.equal(s2.calls(), 3);
  await s2.close();

  const s3 = await start({ script: [say('', call('finish', { summary: 'x' }))], delayMs: 800 });
  const slow = await run(s3, project(), {}, { timeoutMs: 300 });
  assert.equal(slow.timedOut, true);
  await s3.close();
});

test('agent : contexte surveillé, les plus anciennes sorties d’outils sont retirées', async () => {
  const dir = project();
  fs.writeFileSync(path.join(dir, 'gros.txt'), Array.from({ length: 280 }, (_, i) => `ligne ${i} ${'x'.repeat(90)}`).join('\n'));
  const reads = Array.from({ length: 6 }, (_, i) => say('', call('read_file', { path: 'gros.txt', start_line: 1 + i, end_line: 280 })));
  const srv = await start({ script: [...reads, say('', call('finish', { summary: 'ok' }))] });
  await run(srv, dir, { ctx: 8000 });
  const last = srv.requests.at(-1).messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.ok(last.some((c) => c.includes('older tool output removed')), 'une ancienne sortie est retirée');
  assert.ok(last.at(-1).length > 1000, 'la plus récente est conservée en entier');
  await srv.close();
});

test('audit en lecture seule : ni écriture ni tests, outils réduits', async () => {
  const dir = project();
  const srv = await start({ script: [
    say('', call('write_file', { path: 'x.txt', content: 'x' })),
    say('', call('run_tests')),
    say('', call('finish', { summary: 'rapport' })),
  ] });
  const r = await run(srv, dir, {}, { readOnly: true });
  assert.deepEqual(srv.requests[0].tools.map((t) => t.function.name), ['list_files', 'read_file', 'search', 'ask_question', 'finish']);
  assert.match(srv.requests[0].messages[0].content, /READ-ONLY/);
  assert.match(toolResults(srv)[0], /unknown tool "write_file"/);
  assert.ok(!fs.existsSync(path.join(dir, 'x.txt')));
  assert.equal(r.finalMessage, 'rapport');
  await srv.close();
});

test('réglages du modèle : valeurs par défaut et surcharges transmises à Ollama', async () => {
  const dir = project();
  const srv = await start({ script: [say('', call('finish', { summary: 'ok' }))] });
  await run(srv, dir, { ctx: 16384, think: false, temperature: 0.1, topK: 10, keepAlive: '5m' });
  const body = srv.requests[0];
  assert.equal(body.options.num_ctx, 16384);
  assert.equal(body.options.temperature, 0.1);
  assert.equal(body.options.top_k, 10);
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, '5m');
  const d = normalizeLocal({ name: 'x', model: 'm' });
  assert.deepEqual([d.id, d.role, d.ctx, d.maxSteps, d.protectTests, d.fixAttempts], ['ollama:x', 'coder', 32768, 40, true, 2]);
  await srv.close();
});
