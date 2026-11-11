function validate(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('capacité invalide');
}

export class LRUCache {
  #capacity;
  #items = new Map();
  constructor(capacity) { validate(capacity); this.#capacity = capacity; }
  get size() { return this.#items.size; }
  has(key) { return this.#items.has(key); }
  get(key) {
    if (!this.#items.has(key)) return undefined;
    const value = this.#items.get(key);
    this.#items.delete(key);
    this.#items.set(key, value);
    return value;
  }
  set(key, value) {
    this.#items.delete(key);
    if (this.#capacity > 0) this.#items.set(key, value);
    this.#trim();
    return this;
  }
  delete(key) { return this.#items.delete(key); }
  entries() { return [...this.#items]; }
  resize(capacity) {
    validate(capacity);
    this.#capacity = capacity;
    this.#trim();
    return this;
  }
  #trim() {
    while (this.size > this.#capacity) this.#items.delete(this.#items.keys().next().value);
  }
}
