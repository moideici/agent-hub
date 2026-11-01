// Icônes dessinées pour ce dashboard (grille 24 px, trait de 1,7). Le balisage est constant : aucune donnée n'y entre.
const PATHS = {
  overview: '<rect x="3.5" y="3.5" width="7" height="9" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="5" rx="1.6"/><rect x="13.5" y="11.5" width="7" height="9" rx="1.6"/><rect x="3.5" y="15.5" width="7" height="5" rx="1.6"/>',
  tasks: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.2l2.7 2.7L16.3 9.3"/>',
  sessions: '<rect x="3" y="4.5" width="18" height="12.5" rx="2.2"/><path d="M8 20.5h8M12 17v3.5"/><path d="M7.5 9.2l2.4 2-2.4 2M12 13h4"/>',
  codex: '<path d="M12 3.2l7.4 4.3v9L12 20.8l-7.4-4.3v-9z"/><path d="M12 8.2v7.6M8.7 10.1l6.6 3.8M15.3 10.1l-6.6 3.8"/>',
  messages: '<path d="M4 5.5h16a1.5 1.5 0 011.5 1.5v8A1.5 1.5 0 0120 16.5h-8l-4.5 3.5v-3.5H4A1.5 1.5 0 012.5 15V7A1.5 1.5 0 014 5.5z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.2M12 17h.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  folder: '<path d="M3.5 7.5a2 2 0 012-2h4l2 2.2h7a2 2 0 012 2V17a2 2 0 01-2 2h-13a2 2 0 01-2-2z"/>',
  branch: '<circle cx="7" cy="6" r="2.2"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="9" r="2.2"/><path d="M7 8.2v7.6M17 11.2c0 3-3 3.3-6.3 4"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  send: '<path d="M4 12l16-7-6 15-2.6-6z"/><path d="M11.4 14L20 5"/>',
  copy: '<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7.5a2 2 0 002 2h2.5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3A4 4 0 0011 18.7l1-1"/>',
  filter: '<path d="M4 5.5h16l-6 7.2v5.3l-4 1.8v-7.1z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.6a2.5 2.5 0 014.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17.2h.01"/>',
  circle: '<circle cx="12" cy="12" r="7.5"/>',
  bolt: '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2"/><path d="M5 9v9.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V9M10 13h4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  spark: '<path d="M12 3.5l1.9 5.3 5.3 1.9-5.3 1.9L12 17.9l-1.9-5.3-5.3-1.9 5.3-1.9z"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
  return span;
}
