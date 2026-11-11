function validateLine(line) {
  if (!Number.isInteger(line.price) || line.price < 0) {
    throw new RangeError('prix invalide');
  }
  if (!Number.isInteger(line.quantity) || line.quantity < 1) {
    throw new RangeError('quantité invalide');
  }
  if (!Number.isInteger(line.taxRate) || line.taxRate < 0 || line.taxRate > 100) {
    throw new RangeError('taux invalide');
  }
}

function netOf(line) {
  return line.price * line.quantity;
}

function taxOf(line) {
  return Math.round(netOf(line) * line.taxRate / 100);
}

function describeLine(line) {
  validateLine(line);
  const net = netOf(line);
  const tax = taxOf(line);
  return {
    label: line.label,
    net,
    tax,
    gross: net + tax,
  };
}

function sumNet(lines) {
  return lines.reduce((sum, line) => sum + line.net, 0);
}

function sumTax(source) {
  const exactTax = source.reduce((sum, line) => {
    return sum + netOf(line) * line.taxRate / 100;
  }, 0);
  return Math.round(exactTax);
}

export function invoice(source) {
  const lines = source.map(describeLine);
  const net = sumNet(lines);
  const tax = sumTax(source);
  return {
    lines,
    net,
    tax,
    gross: net + tax,
  };
}

export function formatCents(cents) {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new RangeError('montant invalide');
  }
  const euros = Math.floor(cents / 100);
  const remainder = String(cents % 100).padStart(2, '0');
  return euros + ',' + remainder + ' €';
}
