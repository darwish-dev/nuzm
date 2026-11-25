import { sha256Hex } from './sha256';
import { normalizeToolPath } from '../paths';
import { classify, type ErrorClass, type ToolFamily } from './autorepair/classes';

/**
 * Error diagnosis from build/test logs (S-05). A log is DATA produced by a tool the model does not control, but it can still echo hostile text (a test name, a file's content), so
 * the result keeps only: a kind, a normalised relative path, a line, an error code, and a short message with control and bidi characters removed. At most `maxDiagnostics`.
 */
export type DiagnosticKind =
  'typescript' | 'test' | 'module' | 'syntax' | 'lint' | 'dart' | 'gradle' | 'bundler' | 'unknown';
export interface Diagnostic {
  kind: DiagnosticKind;
  path: string | null;
  line: number | null;
  code: string | null;
  message: string;
  /** the error class (P3-S03 repair engine); set by `diagnoseBuildLog`, absent on a hand-built diagnostic */
  class?: ErrorClass;
  /** what the message is about (a name, a module specifier), when it names one: never file content */
  subject?: string | null;
  /** for a failed test: the assertion or error text that followed the test's name (bounded and cleaned like `message`) */
  detail?: string;
}
export const DIAGNOSE_LIMITS = {
  maxDiagnostics: 50,
  maxMessageChars: 300,
  maxLogChars: 200_000,
} as const;

/* eslint-disable no-control-regex -- control and bidi characters are removed on purpose */
const UNSAFE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/* eslint-enable no-control-regex */
const clean = (s: string) =>
  s.replace(UNSAFE, '').replace(/\s+/g, ' ').trim().slice(0, DIAGNOSE_LIMITS.maxMessageChars);

/** A path printed by a tool, made relative to the project (`./a`, absolute paths under a known root) or null when it cannot be one. */
export function toProjectPath(raw: string): string | null {
  let p = raw.trim().replace(/^["'`]|["'`]$/g, '');
  p = p.replace(/^file:\/\//, '');
  const marker = /\/(?:workspace|work|app|project|src-root)\//.exec(p);
  if (p.startsWith('/') && marker) p = p.slice(marker.index + marker[0].length);
  p = p.replace(/^\.\//, '');
  const r = normalizeToolPath(p);
  return r.ok ? r.path : null;
}

const TS_PAREN = /^(.+?)\((\d+),(\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.*)$/;
const TS_COLON = /^(.+?):(\d+):(\d+)\s+-\s+(?:error|warning)\s+(TS\d+):\s+(.*)$/;
const GENERIC_LOC = /^(.+?):(\d+):(\d+):?\s+(?:SyntaxError|error|Error):?\s+(.*)$/;
const NOT_FOUND =
  /(?:Cannot find module|Module not found: Error: Can't resolve)\s+['"]([^'"]{1,200})['"]/;
const TEST_FAIL = /^\s*(?:FAIL|✗|×|❯)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s*[>›]\s*(.*))?$/;
const LINT = /^\s*(\d+):(\d+)\s+error\s+(.*?)\s{2,}([\w@/-]+)\s*$/;
// dart analyze: `  error - lib/main.dart:6:18 - Undefined name 'x'. Try ... - undefined_identifier` (older SDKs print `•` instead of ` - `)
const DART_LINE =
  /^\s*(error|warning)\s+(?:[-•]\s+)(.+?):(\d+):(\d+)\s+(?:[-•]\s+)(.+?)\s+(?:[-•]\s+)([a-z][a-z0-9_]*)\s*$/;
const DART_LINE_OLD =
  /^\s*(error|warning)\s+•\s+(.+?)\s+•\s+(.+?):(\d+):(\d+)\s+•\s+([a-z][a-z0-9_]*)\s*$/;
// flutter/dart test: `00:01 +0 -1: test/widget_test.dart: Counter increments [E]`, then `  Expected: ... Actual: ...`
const DART_TEST =
  /^\s*\d\d:\d\d\s+\+\d+(?:\s+[~]\d+)?\s+-\d+:\s+(\S+_test\.dart):?\s*(.*?)(?:\s+\[E\])?\s*$/;
// Kotlin: `e: file:///app/src/Main.kt:12:5 Unresolved reference: x` or `e: /app/Main.kt: (12, 5): Unresolved reference: x`; javac: `/app/Main.java:12: error: cannot find symbol`
const KOTLIN_E =
  /^e:\s+(?:file:\/\/)?(.+?\.kts?)(?::\s*\((\d+),\s*(\d+)\)|:(\d+):(\d+))\s*:?\s*(.*)$/;
const JAVAC = /^(.+?\.java):(\d+):\s+error:\s+(.*)$/;
const GRADLE_WRONG = /^\s*>\s+(Could not (?:resolve|find|download)[^\n]{0,200})$/;
// bundlers: esbuild `✘ [ERROR] Could not resolve "./x"` + `    src/main.ts:1:7:`; webpack `ERROR in ./src/a.js 5:0-20`; Next `./app/page.tsx:3:10` + `Type error: ...`; Rollup/Vite
const ESBUILD_ERR = /^\s*[✘x]\s*\[ERROR\]\s+(.*)$/;
const LOC_ONLY = /^\s{2,}([^\s:][^:]*?):(\d+):(\d+):?\s*$/;
const WEBPACK_IN =
  /^(?:ERROR in|Module not found:|Module build failed[^:]*:)\s*(?:\.\/)?([^\s]+?)(?:\s+\d+:\d+(?:-\d+)?)?\s*$/;
const NEXT_LOC = /^\.\/([^\s:]+\.[A-Za-z0-9]+)(?::(\d+):(\d+))?\s*$/;
const ROLLUP_RESOLVE =
  /(?:Rollup failed to resolve import|failed to resolve import)\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/i;
const FAILED_ASSERT = /^\s*(?:AssertionError|Error|TypeError|ReferenceError|RangeError):\s+(.*)$/;
const TEST_FRAME =
  /^\s*(?:❯|at)\s+(?:.*?\()?([^\s()]+?\.(?:test|spec)\.[cm]?[jt]sx?):(\d+):(\d+)\)?/;
const EXPECT_JEST = /^\s*(?:expect\(received\)\.\w+\(expected\)|Expected:|Received:)\s*(.*)$/;

const toFamily = (k: DiagnosticKind): ToolFamily =>
  k === 'typescript' || k === 'module' || k === 'syntax'
    ? k === 'typescript'
      ? 'typescript'
      : 'bundler'
    : k === 'test'
      ? 'test'
      : k === 'lint'
        ? 'lint'
        : k === 'dart'
          ? 'dart'
          : k === 'gradle'
            ? 'gradle'
            : k === 'bundler'
              ? 'bundler'
              : 'other';

export function diagnoseBuildLog(logs: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Omit<Diagnostic, 'class' | 'subject'>): Diagnostic | null => {
    const k = `${d.kind}|${d.path}|${d.line}|${d.code}|${d.message}`;
    if (seen.has(k) || out.length >= DIAGNOSE_LIMITS.maxDiagnostics) return null;
    seen.add(k);
    const c = classify({
      family: d.kind === 'syntax' && d.code === null ? 'bundler' : toFamily(d.kind),
      code: d.code,
      message: d.message,
    });
    const full: Diagnostic = { ...d, class: c.class, subject: c.subject };
    out.push(full);
    return full;
  };
  const lines = logs.slice(0, DIAGNOSE_LIMITS.maxLogChars).split('\n');
  let lintFile: string | null = null;
  // the file a bundler named on the line BEFORE its message (`./app/page.tsx`, `ERROR in ./src/a.js`)
  let contextPath: string | null = null;
  let contextLine: number | null = null;
  let lastTest: Diagnostic | null = null;
  type Raw = Omit<Diagnostic, 'class' | 'subject'>;
  const esb: { pending: Raw | null } = { pending: null };
  let esbBlank = 0;
  const flushEsbuild = () => {
    if (esb.pending) push(esb.pending);
    esb.pending = null;
    esbBlank = 0;
  };
  for (const raw of lines) {
    // eslint-disable-next-line no-control-regex -- terminal colour codes are removed on purpose
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    if (esb.pending) {
      const loc = LOC_ONLY.exec(line);
      if (loc) {
        esb.pending = {
          ...esb.pending,
          path: toProjectPath(loc[1]!),
          line: Number(loc[2]),
        };
        flushEsbuild();
        continue;
      }
      // esbuild prints a blank line between the message and its location
      if (line.trim() === '' && esbBlank++ < 2) continue;
      flushEsbuild();
      esbBlank = 0;
    }
    let m: RegExpExecArray | null = TS_PAREN.exec(line) ?? TS_COLON.exec(line);
    if (m) {
      push({
        kind: 'typescript',
        path: toProjectPath(m[1]!),
        line: Number(m[2]),
        code: m[4]!,
        message: clean(m[5]!),
      });
      contextPath = null;
      continue;
    }
    m = DART_LINE.exec(line);
    if (m) {
      push({
        kind: 'dart',
        path: toProjectPath(m[2]!),
        line: Number(m[3]),
        code: m[6]!,
        message: clean(m[5]!),
      });
      continue;
    }
    m = DART_LINE_OLD.exec(line);
    if (m) {
      push({
        kind: 'dart',
        path: toProjectPath(m[3]!),
        line: Number(m[4]),
        code: m[6]!,
        message: clean(m[2]!),
      });
      continue;
    }
    m = DART_TEST.exec(line);
    if (m) {
      lastTest = push({
        kind: 'test',
        path: toProjectPath(m[1]!),
        line: null,
        code: 'test_failed',
        message: clean(m[2] || 'a test failed'),
      });
      continue;
    }
    m = KOTLIN_E.exec(line);
    if (m) {
      push({
        kind: 'gradle',
        path: toProjectPath(m[1]!),
        line: Number(m[2] ?? m[4]),
        code: null,
        message: clean(m[6]!),
      });
      continue;
    }
    m = JAVAC.exec(line);
    if (m) {
      push({
        kind: 'gradle',
        path: toProjectPath(m[1]!),
        line: Number(m[2]),
        code: null,
        message: clean(m[3]!),
      });
      continue;
    }
    m = GRADLE_WRONG.exec(line);
    if (m) {
      push({ kind: 'gradle', path: null, line: null, code: null, message: clean(m[1]!) });
      continue;
    }
    m = ESBUILD_ERR.exec(line);
    if (m) {
      esb.pending = {
        kind: 'bundler',
        path: null,
        line: null,
        code: null,
        message: clean(m[1]!),
      };
      continue;
    }
    m = ROLLUP_RESOLVE.exec(line);
    if (m) {
      push({
        kind: 'bundler',
        path: toProjectPath(m[2]!),
        line: null,
        code: null,
        message: clean(`Could not resolve "${m[1]}"`),
      });
      continue;
    }
    // `Type error: Property 'x' does not exist` printed by Next under `./app/page.tsx:3:10`
    m = /^Type error:\s+(.*)$/.exec(line);
    if (m && contextPath) {
      push({
        kind: 'typescript',
        path: contextPath,
        line: contextLine,
        code: null,
        message: clean(m[1]!),
      });
      continue;
    }
    m = NOT_FOUND.exec(line);
    if (m) {
      push({
        kind: 'module',
        path: contextPath,
        line: contextLine,
        code: 'module_not_found',
        message: clean(`cannot find module ${m[1]}`),
      });
      continue;
    }
    m = TEST_FAIL.exec(line);
    if (m) {
      lastTest = push({
        kind: 'test',
        path: toProjectPath(m[1]!),
        line: null,
        code: 'test_failed',
        message: clean(m[2] ?? 'a test failed'),
      });
      continue;
    }
    if (lastTest) {
      // the lines after a failed test's name carry the assertion and the frame that failed
      const fa = FAILED_ASSERT.exec(line);
      if (fa && lastTest.detail === undefined) {
        lastTest.detail = clean(fa[1]!);
        const c = classify({ family: 'test', code: lastTest.code, message: `${line.trim()}` });
        lastTest.class = c.class;
        lastTest.subject = c.subject;
        continue;
      }
      const ex = EXPECT_JEST.exec(line);
      if (ex && lastTest.detail === undefined && /Expected:/.test(line)) {
        lastTest.detail = clean(line.trim());
        lastTest.class = 'test_assertion';
        continue;
      }
      const fr = TEST_FRAME.exec(line);
      if (fr && lastTest.line === null) {
        const p = toProjectPath(fr[1]!);
        if (p === lastTest.path) lastTest.line = Number(fr[2]);
      }
    }
    m = LINT.exec(line);
    if (m && lintFile) {
      push({
        kind: 'lint',
        path: lintFile,
        line: Number(m[1]),
        code: m[4]!,
        message: clean(m[3]!),
      });
      continue;
    }
    m = GENERIC_LOC.exec(line);
    if (m) {
      push({
        kind: /SyntaxError/.test(line) ? 'syntax' : 'unknown',
        path: toProjectPath(m[1]!),
        line: Number(m[2]),
        code: null,
        message: clean(m[4]!),
      });
      continue;
    }
    // a webpack / Next header names the file the NEXT message is about
    const nx = NEXT_LOC.exec(line.trim());
    if (nx) {
      contextPath = toProjectPath(nx[1]!);
      contextLine = nx[2] ? Number(nx[2]) : null;
      continue;
    }
    const wp = WEBPACK_IN.exec(line.trim());
    if (wp && /^(?:ERROR in|Module build failed)/.test(line.trim())) {
      contextPath = toProjectPath(wp[1]!);
      contextLine = null;
      continue;
    }
    if (/^\/?[\w./-]+\.[cm]?[jt]sx?$/.test(line.trim())) lintFile = toProjectPath(line.trim());
  }
  flushEsbuild();
  return out;
}

/** A stable fingerprint of a set of diagnostics: two iterations with the same fingerprint made no progress. */
export function fingerprint(ds: readonly Diagnostic[]): string {
  const k = ds
    .map((d) => `${d.kind}|${d.path ?? ''}|${d.code ?? ''}|${d.message}`)
    .sort()
    .join('\n');
  return sha256Hex(k).slice(0, 16);
}
