export async function runPool(tasks, { concurrency = 2, retries = 0, signal } = {}) {
  if (!Number.isInteger(concurrency) || concurrency <= 0 || !Number.isInteger(retries) || retries < 0) {
    throw new RangeError('options invalides');
  }
  return new Promise(resolve => {
    const results = new Array(tasks.length);
    const attempts = tasks.map(() => 0);
    let queue = tasks.map((_, i) => i), active = 0, finished = 0, ended = false;
    const finish = () => {
      if (!ended && finished === tasks.length && active === 0) {
        ended = true;
        signal?.removeEventListener('abort', abort);
        resolve(results);
      }
    };
    const abort = () => {
      for (const i of queue) {
        results[i] = { status: 'cancelled', attempts: attempts[i] };
        finished++;
      }
      queue = [];
      finish();
    };
    function settle(i, ok, payload) {
      active--;
      if (!ok && attempts[i] <= retries && !signal?.aborted) queue.push(i);
      else {
        results[i] = ok
          ? { status: 'fulfilled', value: payload, attempts: attempts[i] }
          : { status: 'rejected', reason: payload, attempts: attempts[i] };
        finished++;
      }
      pump();
    }
    function pump() {
      while (active < concurrency && queue.length && !signal?.aborted) {
        const i = queue.shift();
        active++; attempts[i]++;
        let promise;
        try { promise = Promise.resolve(tasks[i]({ attempt: attempts[i], signal })); }
        catch (error) { promise = Promise.reject(error); }
        promise.then(value => settle(i, true, value), reason => settle(i, false, reason));
      }
      finish();
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else pump();
  });
}
