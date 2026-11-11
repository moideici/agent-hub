function validatePage(page, size) {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError('page invalide');
  }
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError('taille invalide');
  }
}

function normalizeQuery(query) {
  return String(query ?? '').trim().toLowerCase();
}

function matches(record, query) {
  if (query === '') {
    return true;
  }
  return record.name.toLowerCase().includes(query);
}

function compareNames(a, b) {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return a.id - b.id;
}

function selectRecords(records, query) {
  const selected = [];
  for (const record of records) {
    if (matches(record, query)) {
      selected.push(record);
    }
  }
  return selected.sort(compareNames);
}

function pageCount(total, size) {
  return Math.ceil(total / size);
}

function links(page, pages) {
  return {
    previous: page > 1 && pages > 0 ? page - 1 : null,
    next: page < pages ? page + 1 : null,
  };
}

export function listRecords(records, options = {}) {
  const { page = 1, size = 2, query = '' } = options;
  validatePage(page, size);
  const selected = selectRecords(records, normalizeQuery(query));
  const total = selected.length;
  const pages = pageCount(total, size);
  const start = (page - 1) * size;
  const end = start + size;
  const items = selected.slice(start, end);
  return {
    items,
    total,
    pages,
    page,
    ...links(page, pages),
  };
}
