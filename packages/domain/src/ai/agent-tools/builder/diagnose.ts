import { sha256Hex } from './sha256';
import { normalizeToolPath } from '../paths';

/**
 * Error diagnosis from build/test logs (S-05). A log is DATA produced by a tool the model does not control, but it can still echo hostile text (a test name, a file's content), so
 * the result keeps only: a kind, a normalised relative path, a line, an error code, and a short message with control and bidi characters removed. At most `maxDiagnostics`.
 */
export type DiagnosticKind = 'typescript' | 'test' | 'module' | 'syntax' | 'lint' | 'unknown';
export interface Diagnostic {
  kind: DiagnosticKind;
  path: string | null;
  line: number | null;
  code: string | null;
  message: string;
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

export function diagnoseBuildLog(logs: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  const push = (d: Diagnostic) => {
    const k = `${d.kind}|${d.path}|${d.line}|${d.code}|${d.message}`;
    if (seen.has(k) || out.length >= DIAGNOSE_LIMITS.maxDiagnostics) return;
    seen.add(k);
    out.push(d);
  };
  const lines = logs.slice(0, DIAGNOSE_LIMITS.maxLogChars).split('\n');
  let lintFile: string | null = null;
  for (const raw of lines) {
    // eslint-disable-next-line no-control-regex -- terminal colour codes are removed on purpose
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m = TS_PAREN.exec(line) ?? TS_COLON.exec(line);
    if (m) {
      push({
        kind: 'typescript',
        path: toProjectPath(m[1]!),
        line: Number(m[2]),
        code: m[4]!,
        message: clean(m[5]!),
      });
      continue;
    }
    m = NOT_FOUND.exec(line);
    if (m) {
      push({
        kind: 'module',
        path: null,
        line: null,
        code: 'module_not_found',
        message: clean(`cannot find module ${m[1]}`),
      });
      continue;
    }
    m = TEST_FAIL.exec(line);
    if (m) {
      push({
        kind: 'test',
        path: toProjectPath(m[1]!),
        line: null,
        code: 'test_failed',
        message: clean(m[2] ?? 'a test failed'),
      });
      continue;
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
    if (/^\/?[\w./-]+\.[cm]?[jt]sx?$/.test(line.trim())) lintFile = toProjectPath(line.trim());
  }
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
