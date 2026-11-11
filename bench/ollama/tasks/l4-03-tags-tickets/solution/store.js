export function createStore() {
  const tickets = new Map();
  return {
    save(ticket) {
      const saved = { ...ticket, tags: [...ticket.tags] };
      tickets.set(saved.id, saved);
      return { ...saved, tags: [...saved.tags] };
    },
    get(id) {
      const ticket = tickets.get(id);
      return ticket ? { ...ticket, tags: [...ticket.tags] } : null;
    },
  };
}
