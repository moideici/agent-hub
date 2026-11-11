export function parseCsvRow(text) {
  if (typeof text !== 'string') throw new TypeError('Chaîne attendue');
  if (/[\r\n]/.test(text)) throw new SyntaxError('Une seule ligne attendue');
  const fields = [];
  let field = '';
  let state = 'start';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state === 'quoted') {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else state = 'closed';
    } else if (ch === ',') {
      fields.push(field);
      field = '';
      state = 'start';
    } else if (ch === '"' && state === 'start') {
      state = 'quoted';
    } else {
      if (ch === '"' || state === 'closed') throw new SyntaxError('Guillemet mal placé');
      field += ch;
      state = 'plain';
    }
  }
  if (state === 'quoted') throw new SyntaxError('Guillemet non fermé');
  fields.push(field);
  return fields;
}
