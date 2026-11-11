import { parseOptions } from './options.js';
import { renderReport } from './render.js';

export function run(args, rows) {
  const { format } = parseOptions(args);
  return renderReport(rows, format);
}
