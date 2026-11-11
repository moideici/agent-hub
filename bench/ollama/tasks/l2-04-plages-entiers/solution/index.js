export function expandRanges(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Chaîne attendue');
  }
  if (/^ *(?![\s\S])/.test(text)) return [];
  const values = new Set();
  for (const token of text.split(',')) {
    const match = /^ *(\d+)(?:-(\d+))? *(?![\s\S])/.exec(token);
    if (!match) {
      throw new RangeError('élément invalide');
    }
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) ||
        start > end || start > 1000 || end > 1000) {
      throw new RangeError('Bornes invalides');
    }
    for (let value = start; value <= end; value++) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
}
