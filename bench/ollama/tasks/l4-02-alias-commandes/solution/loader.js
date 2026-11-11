import { createRegistry } from './registry.js';

export function loadCommands(definitions) {
  const registry = createRegistry();
  for (const definition of definitions) {
    registry.register(definition.name, definition.run, definition.aliases);
  }
  return registry;
}
