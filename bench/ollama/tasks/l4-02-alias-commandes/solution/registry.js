export function createRegistry() {
  const commands = new Map();
  return {
    register(name, handler, aliases = []) {
      const names = [name, ...aliases];
      if (new Set(names).size !== names.length) throw new Error('nom déjà pris');
      for (const key of names) {
        if (commands.has(key)) throw new Error('nom déjà pris: ' + key);
      }
      if (typeof handler !== 'function') throw new TypeError('handler invalide');
      for (const key of names) commands.set(key, handler);
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
