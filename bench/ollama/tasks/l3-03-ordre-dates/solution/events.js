function timestamp(value) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new RangeError('date invalide');
  }
  return result;
}

function validateWindow(from, to) {
  const start = timestamp(from);
  const end = timestamp(to);
  if (start > end) {
    throw new RangeError('fenêtre inversée');
  }
  return { start, end };
}

function isVisible(event, window) {
  const time = timestamp(event.at);
  return time >= window.start && time < window.end;
}

function compareEvents(a, b) {
  const delta = timestamp(a.at) - timestamp(b.at);
  if (delta !== 0) return delta;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function groupByKind(events) {
  const counts = {};
  for (const event of events) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
  }
  return counts;
}

function select(events, window, kind) {
  const result = [];
  for (const event of events) {
    if (isVisible(event, window) && (kind == null || event.kind === kind)) {
      result.push(event);
    }
  }
  return result;
}

export function timeline(events, { from, to, kind = null }) {
  const window = validateWindow(from, to);
  const items = select(events, window, kind).sort(compareEvents);
  return {
    items,
    count: items.length,
    byKind: groupByKind(items),
    firstId: items[0]?.id ?? null,
    lastId: items.at(-1)?.id ?? null,
  };
}

export function eventLabel(event) {
  timestamp(event.at);
  return event.kind + ':' + event.id;
}
