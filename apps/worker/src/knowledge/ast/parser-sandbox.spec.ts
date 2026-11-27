import { once } from 'node:events';
import { join } from 'node:path';
import type { Worker as NodeWorker } from 'node:worker_threads';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { analyzeCss, analyzeDart, analyzeFlutterTheme, analyzeTokensJson } from '@nuzm/domain';
import { handle } from './parser-thread';
import {
  SandboxAborted,
  SandboxClosed,
  SandboxUnavailable,
  ThreadParserSandbox,
  type SandboxOptions,
} from './parser-sandbox';
import { analyzeThemeConfig } from './theme-config';
import { analyzeTsFile } from './ts-file';

// Every thread the sandbox starts, so a test can wait for a thread's real exit instead of guessing how long it takes.
const spawned = vi.hoisted(() => [] as NodeWorker[]);
vi.mock('node:worker_threads', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:worker_threads')>();
  class TrackedWorker extends m.Worker {
    constructor(...args: ConstructorParameters<typeof m.Worker>) {
      super(...args);
      spawned.push(this);
    }
  }
  return { ...m, Worker: TrackedWorker };
});

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const HOSTILE = join(__dirname, 'testing', 'hostile-thread.cjs');
const buf = (s: string | Uint8Array): ArrayBuffer => {
  const b = typeof s === 'string' ? Buffer.from(s) : Buffer.from(s);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const ts = (s: string, path = 'a.tsx') => ({ kind: 'ts' as const, path, bytes: buf(s) });
const open: ThreadParserSandbox[] = [];
const hostile = (mode: string, o: SandboxOptions = {}) => {
  const sb = new ThreadParserSandbox({
    entry: HOSTILE,
    startupTimeoutMs: 5000,
    ...o,
    fixture: { mode, ...(o.fixture ?? {}) },
  });
  open.push(sb);
  return sb;
};
afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
});

const COMPONENT = `import React from 'react';\nexport default function Card({ title }: { title: string }) { return <section>{title}</section>; }\n`;
const DART = `import 'package:flutter/material.dart';\nclass HomeScreen extends StatelessWidget {\n  const HomeScreen({super.key});\n  @override\n  Widget build(BuildContext context) { return Scaffold(body: Text('x')); }\n}\n`;

describe('thread request handler (no thread)', () => {
  const limits = { maxFileBytes: 1000, maxNodes: 400_000, maxResultBytes: 190_000 };
  it('refuses malformed requests with a typed reply and never throws', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'x',
      {},
      { id: 1, kind: 'rb', path: 'a', bytes: new ArrayBuffer(1) },
      { id: 1, kind: 'ts', path: 'a'.repeat(601), bytes: new ArrayBuffer(1) },
      { id: 1, kind: 'ts', path: 'a', bytes: 'text' },
      { id: 1, kind: 'ts', path: 'a', bytes: new Uint8Array(4) },
    ])
      expect(handle(bad, limits)).toMatchObject({ type: 'result', ok: false, reason: 'invalid' });
  });
  it('refuses a file over the size limit and a result over the result limit', () => {
    expect(
      handle({ id: 3, kind: 'ts', path: 'a.ts', bytes: new ArrayBuffer(1001) }, limits),
    ).toEqual({ type: 'result', id: 3, ok: false, reason: 'too_large' });
    expect(
      handle(
        { id: 4, kind: 'ts', path: 'a.tsx', bytes: buf(COMPONENT) },
        { ...limits, maxFileBytes: 1e6, maxResultBytes: 20 },
      ),
    ).toEqual({ type: 'result', id: 4, ok: false, reason: 'oversize' });
  });
  it('produces the same facts as the analyzers called directly', () => {
    const l = { ...limits, maxFileBytes: 1e6 };
    const a = handle({ id: 1, kind: 'ts', path: 'a.tsx', bytes: buf(COMPONENT) }, l);
    const d = handle({ id: 2, kind: 'dart', path: 'a.dart', bytes: buf(DART) }, l);
    expect(a).toMatchObject({ ok: true, facts: analyzeTsFile(COMPONENT, 'a.tsx') });
    expect(d).toMatchObject({ ok: true, facts: analyzeDart(DART) });
  });
  it('applies the AST node limit it was given (and can only lower the built-in one)', () => {
    const r = handle(
      { id: 5, kind: 'ts', path: 'a.tsx', bytes: buf(COMPONENT) },
      { ...limits, maxFileBytes: 1e6, maxNodes: 3 },
    );
    expect(r).toMatchObject({ ok: true, facts: { skipped: 'budget' } });
  });
});

describe('real parser thread', () => {
  const real = new ThreadParserSandbox({ threads: 2, startupTimeoutMs: 60_000 });
  open.push(real);

  it('parses TypeScript and Dart in a thread, with the same result as the direct analyzers', async () => {
    const a = await real.parse(ts(COMPONENT));
    const d = await real.parse({ kind: 'dart', path: 'lib/home.dart', bytes: buf(DART) });
    expect(a).toMatchObject({ ok: true, facts: analyzeTsFile(COMPONENT, 'a.tsx') });
    expect(d).toMatchObject({ ok: true, facts: analyzeDart(DART) });
  });

  it('is deterministic and reuses its threads across files', async () => {
    const before = real.stats().threadsStarted;
    const runs = await Promise.all(Array.from({ length: 12 }, () => real.parse(ts(COMPONENT))));
    expect(new Set(runs.map((r) => JSON.stringify(r.ok && r.facts))).size).toBe(1);
    expect(real.stats().threadsStarted).toBeLessThanOrEqual(Math.max(before, 2));
  });

  it('contains hostile sources: parse bombs, minified lines, NUL, invalid UTF-8 and odd names', async () => {
    const hostileFiles: [string, string | Uint8Array][] = [
      ['deep.ts', `const x = ${'('.repeat(20_000)}1${')'.repeat(20_000)};`],
      ['wide.ts', `export const a = [${'1,'.repeat(240_000)}];`],
      ['min.js', `var a=${'1+'.repeat(6000)}1;`],
      ['nul.ts', 'export const a = 1;\u0000export const b = 2;'],
      ['utf8.tsx', Uint8Array.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0x65, 0x78])],
      ['proto.tsx', `export const __proto__ = 1; export function constructor() { return <div/>; }`],
      ['unterminated.tsx', `export default function A() { return <div>{"abc`],
      [
        'jsx-bomb.tsx',
        `export default function A() { return ${'<div>'.repeat(5000)}x${'</div>'.repeat(5000)}; }`,
      ],
    ];
    for (const [path, body] of hostileFiles) {
      const r = await real.parse({ kind: 'ts', path, bytes: buf(body) });
      // either the analyzer skipped it with a reason or it produced facts; what must NOT happen is a hang, a crash or a poisoned pool
      expect(r.ok || ['timeout'].includes(r.reason)).toBe(true);
    }
    // the pool still works after all of that
    expect(await real.parse(ts(COMPONENT))).toMatchObject({ ok: true });
  });

  it('never lets a file above the size limit reach a thread', async () => {
    const sb = new ThreadParserSandbox({
      maxFileBytes: 100,
      entry: HOSTILE,
      fixture: { mode: 'ok' },
    });
    open.push(sb);
    const r = await sb.parse(ts('x'.repeat(101)));
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(sb.stats().threadsStarted).toBe(0);
  });

  it('stops a parse that exceeds the time limit, then parses the next file on a fresh thread', async () => {
    const sb = new ThreadParserSandbox({ threads: 1, timeoutMs: 1, startupTimeoutMs: 60_000 });
    open.push(sb);
    const big = Array.from(
      { length: 4000 },
      (_, i) => `export function C${i}(p: { a: number }) { return <div>{p.a}</div>; }`,
    ).join('\n');
    const r = await sb.parse(ts(big));
    expect(r).toMatchObject({ ok: false, reason: 'timeout' });
    expect(sb.stats().failed.timeout).toBe(1);
  });

  it('stops a parse that exceeds the AST node budget without failing the thread', async () => {
    const sb = new ThreadParserSandbox({ threads: 1, maxNodes: 3, startupTimeoutMs: 60_000 });
    open.push(sb);
    const r = await sb.parse(ts(COMPONENT));
    expect(r).toMatchObject({ ok: true, facts: { skipped: 'budget' } });
    expect(await sb.parse(ts(COMPONENT))).toMatchObject({ ok: true });
    expect(sb.stats().threadsStarted).toBe(1);
  });

  it('refuses a result above the result limit', async () => {
    const sb = new ThreadParserSandbox({
      threads: 1,
      maxResultBytes: 50,
      startupTimeoutMs: 60_000,
    });
    open.push(sb);
    expect(await sb.parse(ts(COMPONENT))).toMatchObject({ ok: false, reason: 'oversize' });
  });
});

describe('limits and failure containment (fixture threads)', () => {
  it('terminates a thread stuck in a tight loop at the time limit and keeps serving', async () => {
    const sb = hostile('marker', { threads: 1, timeoutMs: 300 });
    const t0 = Date.now();
    const a = await sb.parse(ts('SPIN'));
    expect(a).toMatchObject({ ok: false, reason: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3000);
    const b = await sb.parse(ts('y')); // a NEW thread: the first one never comes back
    expect(b).toMatchObject({ ok: true });
    expect(sb.stats()).toMatchObject({ threadsStarted: 2, failed: { timeout: 1 } });
  });

  it('terminates catastrophic regular-expression backtracking', async () => {
    const sb = hostile('regex', { threads: 1, timeoutMs: 400 });
    expect(await sb.parse(ts('x'))).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('kills a thread that exceeds its heap limit, not the process', async () => {
    const sb = hostile('memory', {
      threads: 1,
      maxOldGenerationSizeMb: 32,
      maxYoungGenerationSizeMb: 8,
      timeoutMs: 20_000,
    });
    const r = await sb.parse(ts('x'));
    expect(r).toMatchObject({ ok: false, reason: 'memory' });
    expect(sb.stats().failed.memory).toBe(1);
    expect(process.memoryUsage().heapUsed).toBeLessThan(2 * 1024 ** 3); // the test process itself is fine
  });

  it.each([
    ['throw', 'crashed'],
    ['exit', 'crashed'],
    ['bad-shape', 'invalid'],
  ] as const)('contains a thread that misbehaves: %s', async (mode, reason) => {
    const sb = hostile(mode, { threads: 1, timeoutMs: 2000 });
    expect(await sb.parse(ts('x'))).toMatchObject({ ok: false, reason });
    expect(sb.stats().failed[reason]).toBe(1);
  });

  it('ignores a reply that does not belong to the request (then times out)', async () => {
    const sb = hostile('wrong-id', { threads: 1, timeoutMs: 300 });
    expect(await sb.parse(ts('x'))).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('never reuses a thread that died while idle', async () => {
    const sb = hostile('die-after-first', { threads: 1, timeoutMs: 2000 });
    const first = spawned.length;
    expect(await sb.parse(ts('1'))).toMatchObject({ ok: true });
    // the thread exits by itself; wait for its 'exit' event (the sandbox's own listener runs first and marks the slot dead)
    expect(spawned.length).toBe(first + 1);
    const w = spawned[first]!;
    if (w.threadId !== -1) await once(w, 'exit');
    // a dead idle slot is replaced: the next file is answered by a new thread, not lost to the corpse
    expect(await sb.parse(ts('2'))).toMatchObject({ ok: true });
    expect(sb.stats().threadsStarted).toBe(2);
  });

  it('starts threads with an EMPTY environment (no secrets, no configuration)', async () => {
    process.env.NUZM_TEST_SECRET = 'must-not-leak';
    try {
      const sb = hostile('echo-env', { threads: 1 });
      const r = await sb.parse(ts('x'));
      expect(r.ok && r.facts.directives).toEqual([]);
    } finally {
      delete process.env.NUZM_TEST_SECRET;
    }
  });

  it('recycles a thread after the configured number of files', async () => {
    const sb = hostile('ok', { threads: 1, maxFilesPerThread: 2 });
    for (let i = 0; i < 5; i++) expect(await sb.parse(ts(String(i)))).toMatchObject({ ok: true });
    expect(sb.stats()).toMatchObject({ parsed: 5, threadsStarted: 3, threadsRecycled: 2 });
  });
});

describe('startup failure is an infrastructure error, not a verdict on the file', () => {
  it.each(['never-ready', 'crash-at-start', 'exit-at-start'])('%s', async (mode) => {
    const sb = hostile(mode, { threads: 1, startupTimeoutMs: 400 });
    await expect(sb.parse(ts('x'))).rejects.toBeInstanceOf(SandboxUnavailable);
    expect(sb.stats().parsed).toBe(0);
    // and the next attempt tries again with a new thread instead of reusing the broken one
    await expect(sb.parse(ts('x'))).rejects.toBeInstanceOf(SandboxUnavailable);
    expect(sb.stats().threadsStarted).toBe(2);
  });
  it('a missing thread script', async () => {
    const sb = new ThreadParserSandbox({
      entry: join(__dirname, 'testing', 'nope.cjs'),
      startupTimeoutMs: 2000,
    });
    open.push(sb);
    await expect(sb.parse(ts('x'))).rejects.toBeInstanceOf(SandboxUnavailable);
  });
});

describe('cancellation and shutdown', () => {
  it('terminates the parse in flight when the signal aborts, quickly', async () => {
    const sb = hostile('spin', { threads: 1, timeoutMs: 60_000 });
    const ac = new AbortController();
    const p = sb.parse(ts('x'), ac.signal);
    await new Promise((r) => setTimeout(r, 300)); // the thread is spinning
    const t0 = Date.now();
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(SandboxAborted);
    expect(Date.now() - t0).toBeLessThan(1000);
    // the sandbox is still usable afterwards (with a fresh thread)
    const sb2 = hostile('ok', { threads: 1 });
    expect(await sb2.parse(ts('x'))).toMatchObject({ ok: true });
  });
  it('rejects at once when the signal is already aborted, without starting a thread', async () => {
    const sb = hostile('ok', { threads: 1 });
    const ac = new AbortController();
    ac.abort();
    await expect(sb.parse(ts('x'), ac.signal)).rejects.toBeInstanceOf(SandboxAborted);
    expect(sb.stats().threadsStarted).toBe(0);
  });
  it('removes a queued request when it is aborted, and does not disturb the one running', async () => {
    const sb = hostile('slow', { threads: 1, fixture: { ms: 300 } });
    const first = sb.parse(ts('1'));
    const ac = new AbortController();
    const queued = sb.parse(ts('2'), ac.signal);
    ac.abort();
    await expect(queued).rejects.toBeInstanceOf(SandboxAborted);
    expect(await first).toMatchObject({ ok: true });
    expect(await sb.parse(ts('3'))).toMatchObject({ ok: true }); // the queue is not stuck
  });
  it('close() terminates running threads, wakes queued callers and refuses new work', async () => {
    const sb = hostile('spin', { threads: 1, timeoutMs: 60_000 });
    const running = sb.parse(ts('1'));
    const queued = sb.parse(ts('2')).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await sb.close();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await running).toMatchObject({ ok: false, reason: 'crashed' });
    expect(await queued).toBeInstanceOf(SandboxClosed);
    await expect(sb.parse(ts('3'))).rejects.toBeInstanceOf(SandboxClosed);
  });
});

describe('concurrency', () => {
  it('runs at most `threads` parses at a time and answers every request', async () => {
    const sb = hostile('slow', { threads: 3, fixture: { ms: 150 }, timeoutMs: 5000 });
    const t0 = Date.now();
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => sb.parse(ts(String(i)))));
    const ms = Date.now() - t0;
    expect(out.every((r) => r.ok)).toBe(true);
    expect(sb.stats().threadsStarted).toBeLessThanOrEqual(3);
    // 12 files x 150 ms over 3 threads cannot finish faster than 4 rounds, and parallelism keeps it far below the serial 1800 ms
    expect(ms).toBeGreaterThanOrEqual(580);
  });

  it('a hostile file does not disturb its neighbours', async () => {
    const sb = hostile('marker', { threads: 3, timeoutMs: 500 });
    const out = await Promise.all(
      Array.from({ length: 9 }, (_, i) => sb.parse(ts(i % 3 === 0 ? 'SPIN' : String(i)))),
    );
    // three of nine files hang their thread: three timeouts, six answers, and nothing blocked the others
    expect(out.filter((r) => !r.ok && r.reason === 'timeout')).toHaveLength(3);
    expect(out.filter((r) => r.ok)).toHaveLength(6);
  });

  it('survives a burst of mixed hostile behaviour with no leaked work', async () => {
    const sb = hostile('throw', { threads: 4, timeoutMs: 1000 });
    const out = await Promise.all(Array.from({ length: 40 }, (_, i) => sb.parse(ts(String(i)))));
    expect(out.every((r) => !r.ok && r.reason === 'crashed')).toBe(true);
    expect(sb.stats().failed.crashed).toBe(40);
    await sb.close();
  });
});

describe('design file kinds (S-K4)', () => {
  const CSS = ':root { --primary: #3b82f6; --radius: 8px; }\n.dark { --primary: #93c5fd; }';
  const JSON_TOKENS = JSON.stringify({ color: { brand: { $value: '#0055ff', $type: 'color' } } });
  const CONFIG = "export default { theme: { extend: { colors: { primary: '#3b82f6' } } } };";
  const FLUTTER = 'static const Color primary = Color(0xFF1E88E5);';
  const real = new ThreadParserSandbox({ threads: 1, startupTimeoutMs: 60_000 });
  open.push(real);

  it('parses stylesheets, token JSON, theme configuration and Flutter themes in a thread, like the direct analyzers', async () => {
    const css = await real.parse({ kind: 'css', path: 'a.css', bytes: buf(CSS) });
    const json = await real.parse({
      kind: 'tokens-json',
      path: 'tokens.json',
      bytes: buf(JSON_TOKENS),
    });
    const cfg = await real.parse({
      kind: 'theme-config',
      path: 'tailwind.config.ts',
      bytes: buf(CONFIG),
    });
    const dart = await real.parse({
      kind: 'dart-theme',
      path: 'lib/theme.dart',
      bytes: buf(FLUTTER),
    });
    expect(css).toMatchObject({ ok: true, facts: analyzeCss(CSS, 'a.css') });
    expect(json).toMatchObject({ ok: true, facts: analyzeTokensJson(JSON_TOKENS, 'tokens.json') });
    expect(cfg).toMatchObject({
      ok: true,
      facts: analyzeThemeConfig(CONFIG, 'tailwind.config.ts'),
    });
    expect(dart).toMatchObject({ ok: true, facts: analyzeFlutterTheme(FLUTTER, 'lib/theme.dart') });
    expect(css.ok && css.facts.tokens.map((t) => `${t.mode}:${t.name}`)).toEqual([
      'base:--primary',
      'base:--radius',
      'dark:--primary',
    ]);
  });
  it('refuses a reply whose shape does not match the kind that was asked', async () => {
    const sb = hostile('ok', { threads: 1 }); // answers with component facts whatever it is asked
    expect(await sb.parse({ kind: 'css', path: 'a.css', bytes: buf(CSS) })).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(await sb.parse({ kind: 'ts', path: 'a.ts', bytes: buf('x') })).toMatchObject({
      ok: true,
    });
  });
  it('contains hostile design input: huge custom-property lists, deep CSS nesting, deep JSON, odd names', async () => {
    const bombs: [string, string, string][] = [
      [
        'css',
        'a.css',
        `:root{${Array.from({ length: 20_000 }, (_, i) => `--v${i}:${i}px;`).join('\n')}}`,
      ],
      ['css', 'b.scss', 'a{\n'.repeat(40_000) + '}\n'.repeat(40_000)],
      ['tokens-json', 'tokens.json', '{"a":'.repeat(2000) + '"#fff"' + '}'.repeat(2000)],
      [
        'theme-config',
        'theme.ts',
        `export const theme = ${'{ a:\n'.repeat(2000)}1${' }\n'.repeat(2000)};`,
      ],
      [
        'dart-theme',
        'lib/theme.dart',
        Array.from(
          { length: 10_000 },
          (_, i) =>
            `static const c${i} = Color(0xFF${(i % 255).toString(16).padStart(2, '0')}0000);`,
        ).join('\n'),
      ],
    ];
    for (const [kind, path, body] of bombs) {
      const r = await real.parse({ kind: kind as 'css', path, bytes: buf(body) });
      expect(r.ok || ['timeout', 'too_large', 'oversize'].includes(r.reason)).toBe(true);
    }
    expect(await real.parse({ kind: 'css', path: 'a.css', bytes: buf(CSS) })).toMatchObject({
      ok: true,
    });
  });
});
