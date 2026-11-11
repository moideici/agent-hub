const clone = value => structuredClone(value);
const own = (object, key) => object !== null && typeof object === 'object' && Object.hasOwn(object, key);
const fail = () => { throw new Error('invalid patch'); };

function pointer(path) {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/')) fail();
  return path.slice(1).split('/').map(segment => {
    if (/~(?:[^01]|$)/.test(segment)) fail();
    return segment.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}
function indexOf(array, key, insert = false) {
  if (insert && key === '-') return array.length;
  if (!/^(0|[1-9]\d*)$/.test(key)) fail();
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index < 0 || index >= array.length + Number(insert)) fail();
  return index;
}
function read(root, parts) {
  let value = root;
  for (const key of parts) {
    if (Array.isArray(value)) value = value[indexOf(value, key)];
    else { if (!own(value, key)) fail(); value = value[key]; }
  }
  return value;
}
function edit(root, parts, mode, value) {
  if (!parts.length) return mode === 'remove' ? null : value;
  const parent = read(root, parts.slice(0, -1)), key = parts.at(-1);
  if (Array.isArray(parent)) {
    const index = indexOf(parent, key, mode === 'add');
    if (mode === 'add') parent.splice(index, 0, value);
    else if (mode === 'remove') parent.splice(index, 1);
    else parent[index] = value;
  } else {
    if (parent === null || typeof parent !== 'object') fail();
    if (mode !== 'add' && !own(parent, key)) fail();
    if (mode === 'remove') delete parent[key];
    else Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return root;
}
function equal(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equal(a[k], b[k]));
}
export function applyPatch(document, operations) {
  let root = clone(document);
  operations.forEach((operation, index) => {
    try {
      const path = pointer(operation.path);
      switch (operation.op) {
        case 'add': case 'replace':
          root = edit(root, path, operation.op, clone(operation.value)); break;
        case 'remove': root = edit(root, path, 'remove'); break;
        case 'test': if (!equal(read(root, path), operation.value)) fail(); break;
        case 'copy': case 'move': {
          const from = pointer(operation.from);
          const value = read(root, from);
          if (operation.op === 'move') {
            if (path.length > from.length && from.every((key, i) => path[i] === key)) fail();
            if (path.length === from.length && from.every((key, i) => path[i] === key)) break;
            root = edit(root, from, 'remove');
          }
          root = edit(root, path, 'add', operation.op === 'copy' ? clone(value) : value);
          break;
        }
        default: fail();
      }
    } catch (cause) {
      const error = new Error(`operation ${index}: invalid patch`, { cause });
      error.name = 'PatchError'; error.index = index; throw error;
    }
  });
  return root;
}
