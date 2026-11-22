import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AC-AG-07 (SCR-K-10 §4): the read-only executors cannot reach a process, the filesystem, the network or any runtime that executes code. They are pure functions over an in-memory
 * snapshot. This test reads the SOURCE of every non-test file of the executor directory and fails on any import or identifier that would give them such a capability, so a future edit
 * cannot add one without this test (and the review of it) noticing. Model tool calling and operating-system execution are separate components (ADR-066, point 7).
 */
const dir = __dirname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .map((f) => ({ f, src: readFileSync(join(dir, f), 'utf8') }));

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the read-only executors have no way out of the process', () => {
  it('there are sources to check', () => {
    expect(sources.map((s) => s.f)).toEqual(
      expect.arrayContaining(['tools.ts', 'paths.ts', 'workspace.ts', 'limits.ts', 'index.ts']),
    );
  });
  it('import nothing but their own files and the pure schema validator', () => {
    for (const { f, src } of sources) {
      const imports = [
        ...strip(src).matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g),
      ].map((m) => m[1]!);
      for (const i of imports)
        expect(i.startsWith('./') || i === '../../schema', `${f} imports ${i}`).toBe(true);
    }
  });
  it('use no process, filesystem, network, worker, vm or dynamic-code capability', () => {
    const forbidden: [RegExp, string][] = [
      [
        /child_process|node:fs|['"]fs['"]|fs\/promises|node:net|['"]net['"]|node:http|node:https|['"]https?['"]|node:dns|node:dgram|node:tls|node:os|node:vm|['"]vm['"]|worker_threads|node:cluster|node:path|node:url/,
        'a node builtin that reaches the system',
      ],
      [/\bprocess\b/, 'process'],
      [/\brequire\s*\(/, 'require()'],
      [/\bimport\s*\(/, 'dynamic import()'],
      [/\beval\s*\(/, 'eval()'],
      [/\bnew\s+Function\b|\bFunction\s*\(/, 'Function constructor'],
      [
        /\bfetch\s*\(|XMLHttpRequest|WebSocket|\bnavigator\b|\bglobalThis\b|\bwindow\b/,
        'a network or global capability',
      ],
      [
        /\bsetTimeout\b|\bsetInterval\b|\bDate\.now\b|\bMath\.random\b|\bnew Date\b|\bperformance\b/,
        'clock or randomness (the tools are pure)',
      ],
      [/\bexec(Sync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(/, 'process creation'],
    ];
    for (const { f, src } of sources) {
      const code = strip(src);
      for (const [re, what] of forbidden)
        expect(re.test(code), `${f} must not use ${what}`).toBe(false);
    }
  });
  it('register no tool that executes anything: the tool names are exactly the four read-only ones', () => {
    const tools = readFileSync(join(dir, 'tools.ts'), 'utf8');
    const names = /READ_TOOL_NAMES = \[([^\]]*)\]/.exec(tools)![1]!.match(/'[a-z_]+'/g);
    expect(names).toEqual(["'list_files'", "'read_file'", "'search_code'", "'inspect_project'"]);
    expect(/name:\s*'(run|exec|shell|bash|write|edit|delete|fetch|curl|install)/.test(tools)).toBe(
      false,
    );
  });
});
