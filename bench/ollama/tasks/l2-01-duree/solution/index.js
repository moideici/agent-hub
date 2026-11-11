export function parseDuration(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Chaîne attendue');
  }
  const parts = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?(?![\s\S])/.exec(text);
  if (!parts || text.length === 0) {
    throw new RangeError('Durée invalide');
  }
  const factors = [3600, 60, 1];
  let total = 0;
  for (let index = 0; index < factors.length; index++) {
    const raw = parts[index + 1];
    if (raw === undefined) continue;
    const value = Number(raw);
    const seconds = value * factors[index];
    total += seconds;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('Durée trop grande');
    }
  }
  return total;
}
