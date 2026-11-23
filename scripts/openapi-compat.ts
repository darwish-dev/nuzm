/**
 * `tsx scripts/openapi-compat.ts <base.yaml> <head.yaml>`: lists what in HEAD could break a client of BASE (see packages/sdk/src/compat.ts for the rules). Exit 1 when anything is
 * BREAKING; warnings alone exit 0. Read-only: it writes nothing.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { compat, type Doc } from '../packages/sdk/src/compat';

const [basePath, headPath] = process.argv.slice(2);
if (!basePath || !headPath) {
  console.error('usage: tsx scripts/openapi-compat.ts <base.yaml> <head.yaml>');
  process.exit(2);
}
const load = (p: string) => parse(readFileSync(p, 'utf8')) as Doc;
const findings = compat(load(basePath), load(headPath));
for (const f of findings) console.log(`${f.level}: ${f.where}: ${f.what}`);
const breaking = findings.filter((f) => f.level === 'BREAKING').length;
console.log(
  `openapi compat: ${breaking} breaking, ${findings.length - breaking} warning(s) (${basePath} -> ${headPath})`,
);
process.exit(breaking > 0 ? 1 : 0);
