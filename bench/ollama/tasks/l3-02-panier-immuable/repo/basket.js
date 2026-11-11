function validateQuantity(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new RangeError('quantité invalide');
  }
}

function validatePrice(price) {
  if (!Number.isInteger(price) || price < 0) {
    throw new RangeError('prix invalide');
  }
}

function findProduct(catalog, sku) {
  const product = catalog.find(item => item.sku === sku);
  if (!product) {
    throw new Error('produit inconnu');
  }
  validatePrice(product.price);
  return product;
}

function findLine(lines, sku) {
  return lines.findIndex(line => line.sku === sku);
}

function total(lines) {
  return lines.reduce((sum, line) => {
    return sum + line.price * line.quantity;
  }, 0);
}

function summarize(lines) {
  return {
    lines,
    total: total(lines),
    count: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

export function emptyBasket() {
  return summarize([]);
}

export function addProduct(basket, catalog, sku, quantity = 1) {
  validateQuantity(quantity);
  const product = findProduct(catalog, sku);
  const lines = [...basket.lines];
  const index = findLine(lines, sku);
  if (index === -1) {
    lines.push({ sku, price: product.price, quantity });
  } else {
    lines[index].quantity += quantity;
  }
  return summarize(lines);
}

export function removeProduct(basket, sku) {
  const lines = basket.lines.filter(line => line.sku !== sku);
  return summarize(lines);
}

export function basketLabel(basket) {
  return basket.count === 1 ? '1 article' : basket.count + ' articles';
}
