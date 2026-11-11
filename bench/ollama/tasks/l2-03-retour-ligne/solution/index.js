export function wrapText(text, width) {
  if (typeof text !== 'string') {
    throw new TypeError('Chaîne attendue');
  }
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError('Largeur invalide');
  }
  const normalized = text.trim();
  if (normalized === '') return [];
  const words = normalized.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}
