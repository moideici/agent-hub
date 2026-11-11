export function renderReport(rows, format) {
  if (format !== 'text') throw new Error('format inconnu: ' + format);
  return rows.map(row => row.name + ': ' + row.count).join('\n');
}
