export function normalizeTicket(raw) {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new TypeError('id invalide');
  if (typeof raw.title !== 'string' || raw.title.trim() === '') throw new TypeError('titre invalide');
  return { id: raw.id.trim(), title: raw.title.trim(), status: raw.status ?? 'open' };
}
