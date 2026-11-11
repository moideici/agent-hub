export function dispatch(registry, name, args = []) {
  return registry.resolve(name)(args);
}
