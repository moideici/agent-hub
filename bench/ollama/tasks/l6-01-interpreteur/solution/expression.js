export function evaluate(source, variables = {}) {
  let offset = 0, token;
  const syntax = (pos = token.pos) => { throw new SyntaxError(`syntax at ${pos}`); };
  function advance() {
    while (/\s/.test(source[offset] || '') && offset < source.length) offset++;
    const pos = offset;
    if (offset === source.length) { token = { kind: 'end', pos }; return; }
    const rest = source.slice(offset);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    const name = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (number) token = { kind: 'number', value: Number(number[0]), pos, text: number[0] };
    else if (name) token = { kind: 'name', value: name[0], pos, text: name[0] };
    else {
      const op = /^(?:<=|>=|==|!=|&&|\|\||[+\-!*\/%^<>()?:])/.exec(rest);
      if (!op) syntax(pos);
      token = { kind: op[0], text: op[0], pos };
    }
    offset += token.text.length;
  }
  function take(kind) {
    if (token.kind !== kind) syntax();
    const result = token; advance(); return result;
  }
  function primary() {
    const t = token;
    if (t.kind === 'number' || t.kind === 'name') { advance(); return t; }
    if (t.kind === '(') { advance(); const node = conditional(); take(')'); return node; }
    syntax();
  }
  function power() {
    const left = primary();
    if (token.kind !== '^') return left;
    const op = take('^');
    return { kind: 'binary', op: op.kind, pos: op.pos, left, right: unary() };
  }
  function unary() {
    if (['+', '-', '!'].includes(token.kind)) {
      const op = token; advance();
      return { kind: 'unary', op: op.kind, child: unary() };
    }
    return power();
  }
  const levels = [['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
  function binary(level = 0) {
    if (level === levels.length) return unary();
    let left = binary(level + 1);
    while (levels[level].includes(token.kind)) {
      const op = token; advance();
      left = { kind: 'binary', op: op.kind, pos: op.pos, left, right: binary(level + 1) };
    }
    return left;
  }
  function conditional() {
    const condition = binary();
    if (token.kind !== '?') return condition;
    advance(); const yes = conditional(); take(':');
    return { kind: 'conditional', condition, yes, no: conditional() };
  }
  function run(node) {
    if (node.kind === 'number') return node.value;
    if (node.kind === 'name') {
      if (!Object.hasOwn(variables, node.value)) throw new ReferenceError(`unknown ${node.value} at ${node.pos}`);
      return variables[node.value];
    }
    if (node.kind === 'conditional') return run(node.condition) !== 0 ? run(node.yes) : run(node.no);
    if (node.kind === 'unary') {
      const value = run(node.child);
      return node.op === '+' ? +value : node.op === '-' ? -value : Number(value === 0);
    }
    const a = run(node.left);
    if (node.op === '&&' && a === 0) return 0;
    if (node.op === '||' && a !== 0) return 1;
    const b = run(node.right);
    if ((node.op === '/' || node.op === '%') && b === 0) throw new RangeError(`division by zero at ${node.pos}`);
    switch (node.op) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '^': return a ** b;
      case '<': return Number(a < b);
      case '<=': return Number(a <= b);
      case '>': return Number(a > b);
      case '>=': return Number(a >= b);
      case '==': return Number(a === b);
      case '!=': return Number(a !== b);
      case '&&': case '||': return Number(b !== 0);
    }
  }
  advance();
  const tree = conditional();
  if (token.kind !== 'end') syntax();
  return run(tree);
}
