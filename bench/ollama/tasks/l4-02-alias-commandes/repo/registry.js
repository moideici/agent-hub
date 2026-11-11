export function createRegistry() {
  const commands = new Map();
  return {
    register(name, handler) {
      if (commands.has(name)) throw new Error('nom déjà pris: ' + name);
      if (typeof handler !== 'function') throw new TypeError('handler invalide');
      commands.set(name, handler);
    },
    resolve(name) {
      if (!commands.has(name)) throw new Error('commande inconnue: ' + name);
      return commands.get(name);
    },
    names() {
      return [...commands.keys()].sort();
    },
  };
}
