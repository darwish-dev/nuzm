import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The repository scanner (`pnpm scan:secrets`) has no rule for Anthropic-style keys (`sk-ant-…` contains hyphens, so its `sk-` rule never matches one). Until that rule exists this
 * guard stands in for it, for the vendor this package serves: no text file of the checkout (code, fixtures, docs, reports, specs, config) may contain a string shaped like a Claude API key.
 * Tests build their synthetic keys at runtime from parts, never as a literal of this shape.
 */
const root = join(__dirname, '..', '..', '..', '..');
const skipDirs = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'coverage',
  '.turbo',
  '.claude',
  '.dev-vault',
  'test-results',
  'playwright-report',
]);
const textExt = /\.(ts|tsx|js|mjs|cjs|json|ya?ml|md|env|example|sh|css|html|sql|txt|toml|svg)$/i;
const SHAPES: [string, RegExp][] = [
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{16,}/],
  ['Anthropic admin key', /\bsk-ant-admin[0-9]*-[A-Za-z0-9_-]{8,}/],
  [
    'Authorization header carrying a long token',
    /Authorization['"]?\s*[:=]\s*['"`]Bearer\s+[A-Za-z0-9._-]{30,}/,
  ],
];
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (skipDirs.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.size < 2_000_000 && textExt.test(name)) yield p;
  }
}

describe('no vendor API key is committed anywhere in the checkout', () => {
  it('finds no Anthropic-shaped key in any text file (fixtures, docs, reports, specs, config)', () => {
    const hits: string[] = [];
    let files = 0;
    for (const f of walk(root)) {
      files += 1;
      const text = readFileSync(f, 'utf8');
      for (const [name, re] of SHAPES)
        if (re.test(text)) hits.push(`${f.slice(root.length + 1)} (${name})`);
    }
    expect(files).toBeGreaterThan(500); // the walk really covered the checkout
    expect(hits).toEqual([]);
  }, 120_000);
});
