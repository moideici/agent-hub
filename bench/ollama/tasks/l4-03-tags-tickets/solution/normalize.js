function normalizeTags(tags = []) {
  if (!Array.isArray(tags)) throw new TypeError('tags invalides');
  const result = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new TypeError('tag invalide');
    const normalized = tag.trim().toLowerCase();
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

export function normalizeTicket(raw) {
  if (typeof raw.id !== 'string' || raw.id.trim() === '') throw new TypeError('id invalide');
  if (typeof raw.title !== 'string' || raw.title.trim() === '') throw new TypeError('titre invalide');
  return { id: raw.id.trim(), title: raw.title.trim(), status: raw.status ?? 'open', tags: normalizeTags(raw.tags) };
}
