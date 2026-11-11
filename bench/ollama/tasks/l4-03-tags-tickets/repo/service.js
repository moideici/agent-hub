import { normalizeTicket } from './normalize.js';

function present(ticket) {
  if (!ticket) return null;
  return { id: ticket.id, title: ticket.title, status: ticket.status };
}

export function createService(store) {
  return {
    create(raw) {
      return present(store.save(normalizeTicket(raw)));
    },
    find(id) {
      return present(store.get(id));
    },
  };
}
