/**
 * Minimal secret scanner (bootstrap B9). Placeholder until a dedicated scanner (e.g. gitleaks)
 * is wired in CI (needs a remote, D-01). Scans text files outside ignored directories.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
// `.claude` holds other sessions' separate checkouts (worktrees); each checkout is scanned from its own root
const skipDirs = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  '.claude',
]);
const skipFiles = new Set(['pnpm-lock.yaml']);
const textExt = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|env|example|sh|css|html|sql|txt|toml)$/i;

const rules: Array<[string, RegExp]> = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['API key style (sk-)', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI project or service key', /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{20,}/],
  ['hardcoded password assignment', /\b(?:password|passwd|secret)\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];

/**
 * PCI scope reduction (M03 §9): a payment card number must never be committed, not even a "test" one. A hit is a 13-19 digit run
 * (contiguous, or grouped by spaces/dashes in the card layout) that does not start with 0 and passes the Luhn check. Tests that
 * need one build it at runtime from parts.
 */
function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (dbl && (n *= 2) > 9) n -= 9;
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
const CARD_RUNS = [
  /(?<![0-9A-Za-z_.-])[1-9][0-9]{12,18}(?![0-9A-Za-z_.-])/g,
  /(?<![0-9A-Za-z_.-])[1-9][0-9]{3}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,7}(?![0-9A-Za-z_.-])/g,
];
const hasCardNumber = (line: string) =>
  CARD_RUNS.some((re) =>
    [...line.matchAll(re)].some((m) => {
      const d = m[0].replace(/[ -]/g, '');
      return d.length >= 13 && d.length <= 19 && !/^(\d)\1+$/.test(d) && luhn(d);
    }),
  );

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (skipDirs.has(f)) return [];
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) return walk(p);
    return textExt.test(f) || f === '.env' || f.startsWith('.env')
      ? skipFiles.has(f)
        ? []
        : [p]
      : [];
  });
}

const hits: string[] = [];
let files = 0;
for (const f of walk(root)) {
  files++;
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of rules)
      if (re.test(line)) hits.push(`${relative(root, f)}:${i + 1} ${name}`);
    if (hasCardNumber(line))
      hits.push(`${relative(root, f)}:${i + 1} payment card number (Luhn-valid)`);
  });
}
if (hits.length) {
  console.error('POSSIBLE SECRETS:\n' + hits.map((h) => ' - ' + h).join('\n'));
  process.exit(1);
}
console.log(`secret scan OK: ${files} files, ${rules.length + 1} rules, 0 hits.`);
