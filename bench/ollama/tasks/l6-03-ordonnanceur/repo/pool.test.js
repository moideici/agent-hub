import test from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from './pool.js';
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const fulfilled = (value, attempts = 1) => ({ status: 'fulfilled', value, attempts });
const rejected = (reason, attempts = 1) => ({ status: 'rejected', reason, attempts });
const cancelled = (attempts = 0) => ({ status: 'cancelled', attempts });

test('limite de concurrence, remplissage immédiat et ordre des résultats', async () => {
  const gates = Array.from({ length: 4 }, deferred);
  const starts = Array.from({ length: 4 }, deferred);
  const calls = [], running = new Set();
  let peak = 0;
  const tasks = Object.freeze(gates.map((gate, i) => async ({ attempt }) => {
    calls.push(i); running.add(i); peak = Math.max(peak, running.size);
    assert.equal(attempt, 1); starts[i].resolve();
    const value = await gate.promise; running.delete(i); return value;
  }));
  const result = runPool(tasks, Object.freeze({ concurrency: 2 }));
  await Promise.all([starts[0].promise, starts[1].promise]);
  assert.deepEqual(calls, [0, 1]);
  gates[1].resolve('b'); await starts[2].promise;
  assert.deepEqual(calls, [0, 1, 2]);
  gates[2].resolve('c'); await starts[3].promise;
  gates[3].resolve('d'); gates[0].resolve('a');
  assert.deepEqual(await result, ['a', 'b', 'c', 'd'].map(v => fulfilled(v)));
  assert.equal(peak, 2);
});
test('reprises FIFO, exceptions synchrones et budget par tâche', async () => {
  const calls = [], first = new Error('first'), second = new Error('second');
  const aValue = { a: 1 };
  const result = await runPool([
    ({ attempt }) => { calls.push(`a${attempt}`); if (attempt < 3) throw first; return aValue; },
    ({ attempt }) => { calls.push(`b${attempt}`); return Promise.reject(second); },
    ({ attempt }) => { calls.push(`c${attempt}`); return undefined; },
  ], { concurrency: 1, retries: 2 });
  assert.deepEqual(calls, ['a1', 'b1', 'c1', 'a2', 'b2', 'a3', 'b3']);
  assert.deepEqual(result, [fulfilled(aValue, 3), rejected(second, 3), fulfilled(undefined)]);
  assert.equal(result[0].value, aValue); assert.equal(result[1].reason, second);
});
test('un rejet ne bloque pas les autres tâches et aucune reprise implicite', async () => {
  const reason = { code: 4 }; let count = 0;
  const result = await runPool([() => { count++; throw reason; }, () => 9]);
  assert.deepEqual(result, [rejected(reason), fulfilled(9)]);
  assert.equal(result[0].reason, reason); assert.equal(count, 1);
});
test('annulation préalable et validation avant tout lancement', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0; const task = () => { calls++; return 1; };
  assert.deepEqual(await runPool([task, task], { signal: controller.signal }), [cancelled(), cancelled()]);
  assert.deepEqual(await runPool([]), []);
  for (const concurrency of [0, -1, 1.5, Infinity, '2', null, NaN]) {
    await assert.rejects(runPool([task], { concurrency }), RangeError);
    await assert.rejects(runPool([], { concurrency }), RangeError);
  }
  for (const retries of [-1, .5, Infinity, '1', null, NaN]) await assert.rejects(runPool([task], { retries }), RangeError);
  assert.equal(calls, 0);
});
test('annulation en vol : attendre les actifs, conserver leur résultat, pas de reprise', async () => {
  const controller = new AbortController(), a = deferred(), b = deferred();
  const started = [deferred(), deferred()]; const calls = [];
  const reason = new Error('late failure');
  const result = runPool([
    ({ signal }) => { assert.equal(signal, controller.signal); calls.push(0); started[0].resolve(); return a.promise; },
    () => { calls.push(1); started[1].resolve(); return b.promise; },
    () => { calls.push(2); return 3; },
  ], { concurrency: 2, retries: 3, signal: controller.signal });
  let complete = false; result.then(() => { complete = true; });
  await Promise.all(started.map(x => x.promise));
  controller.abort(); a.resolve(7);
  // Laisser passer les réactions déjà en file, sans horloge ni attente réelle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(complete, false);
  b.reject(reason);
  assert.deepEqual(await result, [fulfilled(7), rejected(reason), cancelled()]);
  assert.deepEqual(calls, [0, 1]);
});
test('une reprise déjà en file est annulée avec son compteur conservé', async () => {
  const controller = new AbortController(), hold = deferred(), started = deferred();
  let count = 0;
  const result = runPool([
    () => { count++; throw new Error('retry me'); },
    () => { started.resolve(); return hold.promise; },
  ], { concurrency: 1, retries: 2, signal: controller.signal });
  await started.promise; controller.abort(); hold.resolve(2);
  assert.deepEqual(await result, [cancelled(1), fulfilled(2)]);
  assert.equal(count, 1);
});
test('annulation déclenchée par une tâche synchrone et appels indépendants', async () => {
  const controller = new AbortController(); let extra = 0;
  assert.deepEqual(await runPool([
    () => { controller.abort(); return 1; },
    () => { extra++; return 2; },
  ], { concurrency: 2, signal: controller.signal }), [fulfilled(1), cancelled()]);
  assert.equal(extra, 0);
  const gate = deferred(), started = deferred();
  const first = runPool([() => { started.resolve(); return gate.promise; }], { concurrency: 1 });
  await started.promise;
  assert.deepEqual(await runPool([() => 8]), [fulfilled(8)]);
  gate.resolve(4); assert.deepEqual(await first, [fulfilled(4)]);
});

test('les écouteurs sont retirés après réussite, échec, vide et annulation', async () => {
  for (const mode of ['success', 'failure', 'empty', 'abort']) {
    const controller = new AbortController(), signal = controller.signal;
    const listeners = new Set();
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (type, callback, options) => {
      if (type === 'abort') listeners.add(callback);
      return add(type, callback, options);
    };
    signal.removeEventListener = (type, callback, options) => {
      if (type === 'abort') listeners.delete(callback);
      return remove(type, callback, options);
    };
    const tasks = mode === 'empty' ? [] : [() => {
      if (mode === 'abort') controller.abort();
      if (mode === 'failure') throw new Error('failure');
      return 1;
    }];
    await runPool(tasks, { signal });
    assert.equal(listeners.size, 0, mode);
  }
});
