export function createStore() {
  const tickets = new Map();
  return {
    save(ticket) {
      const saved = { ...ticket };
      tickets.set(saved.id, saved);
      return { ...saved };
    },
    get(id) {
      const ticket = tickets.get(id);
      return ticket ? { ...ticket } : null;
    },
  };
}
