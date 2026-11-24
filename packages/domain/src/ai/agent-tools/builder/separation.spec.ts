import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * S-05: the builder tools (diff, preview, rollback plans, planning, review, repair loop, memory, compression) are PURE: they reach no process, filesystem, network, clock or random
 * source, and execute nothing. Builds and tests are only ever requested through the injected `BuildPort`, whose only implementation here is a scripted mock. `node:crypto` is allowed
 * for hashing alone. A future edit that adds a capability fails here and must be reviewed (same rule as the read-only executors, AC-AG-07).
 */
const root = __dirname;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
const sources = walk(root).map((p) => ({ f: p.slice(root.length + 1), src: readFileSync(p, 'utf8') }));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** code with string literals blanked: a NAME inside a string (a list of module names, a message) is data, not a capability */
const code = (s: string) => strip(s).replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");

describe('the builder tools are pure and execute nothing', () => {
  it('there are sources to check', () => {
    expect(sources.length).toBeGreaterThan(15);
  });
  it('import only relative modules and node:crypto', () => {
    for (const { f, src } of sources) {
      const imports = [...strip(src).matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const i of imports) expect(i.startsWith('.') || i === 'node:crypto', `${f} imports ${i}`).toBe(true);
    }
  });
  it('use no process, filesystem, network, clock, randomness or dynamic code', () => {
    const forbidden: [RegExp, string][] = [
      [/\bprocess\b/, 'process'],
      [/\brequire\s*\(/, 'require()'],
      [/\bimport\s*\(/, 'dynamic import()'],
      [/\beval\s*\(/, 'eval()'],
      [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function constructor'],
      [/\bfetch\s*\(|XMLHttpRequest|WebSocket|\bnavigator\b|\bglobalThis\b|\bwindow\b/, 'a network or global capability'],
      [/\bsetTimeout\b|\bsetInterval\b|\bDate\.now\b|\bMath\.random\b|\bnew Date\b|\bperformance\b|\brandomUUID\b|\brandomBytes\b/, 'clock or randomness'],
      [/(?<![.\w$])exec(Sync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(/, 'process creation (RegExp.exec is a method call and is allowed)'],
    ];
    for (const { f, src } of sources)
      for (const [re, what] of forbidden) expect(re.test(code(src)), `${f} must not use ${what}`).toBe(false);
  });
  it('the only `child_process` text is data: the validator DETECTING it in build configuration and the list of Node module names', () => {
    const hits = sources.filter((s) => /child_process/.test(strip(s.src))).map((s) => s.f);
    expect(hits).toEqual(['code-intel.ts', 'validate.ts']);
  });
  it('the build port has no implementation that runs anything: the only one is scripted', () => {
    const port = sources.find((s) => s.f === 'build-port.ts')!.src;
    expect([...port.matchAll(/class (\w+) implements BuildPort/g)].map((m) => m[1])).toEqual(['ScriptedBuildPort']);
    expect(port).toMatch(/origin = 'MOCK'/);
  });
});
