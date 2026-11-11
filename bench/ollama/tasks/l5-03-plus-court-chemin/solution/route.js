function compare(a, b) {
  if (a.distance !== b.distance) return a.distance < b.distance ? -1 : 1;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  for (let i = 0; i < a.path.length; i++) {
    if (a.path[i] !== b.path[i]) return a.path[i] < b.path[i] ? -1 : 1;
  }
  return 0;
}

export function shortestPath(edges, start, end) {
  const graph = new Map();
  for (const [from, to, cost] of edges) {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new RangeError('coût invalide');
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push([to, cost]);
  }
  const best = new Map([[start, { distance: 0, path: [start] }]]);
  const settled = new Set();
  while (true) {
    let current, label;
    for (const [id, candidate] of best) {
      if (!settled.has(id) && (!label || compare(candidate, label) < 0)) {
        current = id; label = candidate;
      }
    }
    if (!label) return null;
    if (current === end) return label;
    settled.add(current);
    for (const [to, cost] of graph.get(current) || []) {
      if (settled.has(to)) continue;
      const candidate = { distance: label.distance + cost, path: [...label.path, to] };
      if (!best.has(to) || compare(candidate, best.get(to)) < 0) best.set(to, candidate);
    }
  }
}
