import { existsSync } from 'node:fs';
const required = ['out/index.html', 'out/404.html'];
const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`Missing static export files: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('static export OK');
