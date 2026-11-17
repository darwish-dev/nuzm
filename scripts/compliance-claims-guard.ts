/**
 * Compliance-claims guard (docs/10 intro; M04 §9, AC-M04-10). Nothing the platform ships may say that Nuzm "is compliant", "certified" or "approved"
 * under any regime. Fails when (1) spec/compliance/controls.yaml is invalid or any control claims compliance, (2) a user-facing source, message
 * catalogue, API description or spec text contains a claim word. Tests, docs and this script are exempt (docs may quote the rule). Run by `pnpm verify`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseControls } from '../packages/db/src/controls';

const root = join(__dirname, '..');
const ROOTS = [
  'apps/web',
  'apps/admin',
  'apps/api/src',
  'packages/i18n',
  'packages/ui',
  'spec/openapi',
  'spec/compliance',
];
const SKIP_DIR = new Set([
  'node_modules',
  '.next',
  'dist',
  'coverage',
  'test-results',
  '.turbo',
  'e2e',
]);
const EXT = /\.(ts|tsx|json|yaml|yml|mjs)$/;
const EXEMPT = /(\.spec\.|\.test\.|\.int\.spec\.)/;
// English claim words and Arabic equivalents (ممتثل / متوافق مع النظام / معتمد من)
const CLAIM = /\b(compliant|certified|complies)\b|ممتثل|معتمد من/i;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    if (SKIP_DIR.has(n)) return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const problems: string[] = [];
try {
  parseControls(readFileSync(join(root, 'spec/compliance/controls.yaml'), 'utf8'));
} catch (e) {
  problems.push(String((e as Error).message));
}
let scanned = 0;
for (const r of ROOTS)
  for (const f of walk(join(root, r))) {
    if (!EXT.test(f) || EXEMPT.test(f)) continue;
    scanned++;
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (CLAIM.test(line))
          problems.push(`${relative(root, f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
  }
if (problems.length) {
  console.error(`compliance claims guard FAILED:\n - ${problems.join('\n - ')}`);
  process.exit(1);
}
console.log(
  `compliance claims guard OK: controls.yaml valid, ${scanned} files without a claim word`,
);
