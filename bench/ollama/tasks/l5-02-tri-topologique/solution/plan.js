export function plan(nodes) {
  const indices = new Map();
  nodes.forEach((node, i) => {
    if (indices.has(node.id)) throw new Error(`duplicate id: ${node.id}`);
    indices.set(node.id, i);
  });
  const counts = nodes.map(() => 0);
  const next = nodes.map(() => []);
  nodes.forEach((node, i) => {
    for (const dep of new Set(node.deps)) {
      if (!indices.has(dep)) throw new Error(`unknown dependency: ${dep}`);
      counts[i]++;
      next[indices.get(dep)].push(i);
    }
  });
  // Min-heap des positions d'entrée disponibles.
  const heap = [];
  const push = (value) => {
    let i = heap.length;
    heap.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent] <= value) break;
      heap[i] = heap[parent]; i = parent;
    }
    heap[i] = value;
  };
  const pop = () => {
    const result = heap[0], last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (2 * i + 1 < heap.length) {
        let child = 2 * i + 1;
        if (child + 1 < heap.length && heap[child + 1] < heap[child]) child++;
        if (heap[child] >= last) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return result;
  };
  counts.forEach((n, i) => { if (n === 0) push(i); });
  const order = [], done = new Set();
  while (heap.length) {
    const i = pop();
    done.add(i); order.push(nodes[i].id);
    for (const target of next[i]) if (--counts[target] === 0) push(target);
  }
  return { order, blocked: nodes.filter((_, i) => !done.has(i)).map(n => n.id) };
}
