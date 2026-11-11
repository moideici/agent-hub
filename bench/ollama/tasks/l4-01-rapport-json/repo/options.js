export function parseOptions(args) {
  let format = 'text';
  for (const arg of args) {
    if (arg === '--text') format = 'text';
    else throw new Error('option inconnue: ' + arg);
  }
  return { format };
}
