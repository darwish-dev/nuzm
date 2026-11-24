import { scanForSecrets } from '../../secret-scan';
import { isAgentSensitivePath } from '../paths';
import { analyzeImports, isCodePath } from './code-intel';

/**
 * Static code validation and the review pass (S-05). Nothing is executed: the checks read text. A finding carries a stable `code` (the UI translates it) and a fixed English
 * message; it never quotes file content, so a hostile file cannot smuggle text through a finding into a prompt or a screen.
 */
export type Severity = 'error' | 'warning' | 'info';
export interface Finding {
  severity: Severity;
  code: string;
  path: string | null;
  line: number | null;
  message: string;
}
const f = (
  severity: Severity,
  code: string,
  path: string | null,
  line: number | null,
  message: string,
): Finding => ({ severity, code, path, line, message });

export const VALIDATE_LIMITS = {
  maxFileBytes: 1_000_000,
  maxFindings: 200,
  maxFiles: 5_000,
} as const;

type Open = { ch: string; line: number };
const PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const REGEX_PREV = new Set('(,=:[!&|?{};'.split(''));
const KEYWORD_BEFORE_REGEX =
  /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)\s*$/;

/**
 * Bracket balance of a JS/TS/CSS file, aware of comments, strings, template literals and regex literals. A quote that does not close on its own line is treated as plain text (an
 * apostrophe in JSX text), so a real file is never reported broken because of it. Returns the first problem, or null.
 */
export function bracketProblem(
  text: string,
  opts: { css?: boolean } = {},
): { line: number; kind: 'mismatch' | 'unclosed' | 'unexpected' } | null {
  const stack: Open[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  let lastSig = '';
  let tail = '';
  const sig = (c: string) => {
    if (!/\s/.test(c)) lastSig = c;
    tail = (tail + c).slice(-12);
  };
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === '\n') {
      line++;
      sig(c);
      i++;
    } else if (c === '/' && d === '/' && !opts.css) {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'") {
      // a string must close on the same line, otherwise the quote is text
      let j = i + 1;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        else if (text[j] === c) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        i = j + 1;
        lastSig = 'a';
      } else {
        i++;
      }
    } else if (c === '`' && !opts.css) {
      i++;
      // template literal: skip text; `${` opens an expression whose brackets must balance on their own
      let depth = 0;
      while (i < n) {
        const t = text[i]!;
        if (t === '\\') i += 2;
        else if (t === '\n') {
          line++;
          i++;
        } else if (depth === 0 && t === '`') {
          i++;
          break;
        } else if (t === '$' && text[i + 1] === '{') {
          depth++;
          i += 2;
        } else if (depth > 0 && t === '{') {
          depth++;
          i++;
        } else if (depth > 0 && t === '}') {
          depth--;
          i++;
        } else i++;
      }
      lastSig = 'a';
    } else if (
      c === '/' &&
      !opts.css &&
      (lastSig === '' || REGEX_PREV.has(lastSig) || KEYWORD_BEFORE_REGEX.test(tail))
    ) {
      // regex literal
      let j = i + 1;
      let cls = false;
      let closed = false;
      while (j < n && text[j] !== '\n') {
        const r = text[j]!;
        if (r === '\\') j++;
        else if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        i = j + 1;
        lastSig = 'a';
      } else {
        sig(c);
        i++;
      }
    } else {
      if (c === '(' || c === '[' || c === '{') stack.push({ ch: c, line });
      else if (c === ')' || c === ']' || c === '}') {
        const top = stack.pop();
        if (!top) return { line, kind: 'unexpected' };
        if (top.ch !== PAIRS[c]) return { line, kind: 'mismatch' };
      }
      sig(c);
      i++;
    }
  }
  const left = stack.pop();
  return left ? { line: left.line, kind: 'unclosed' } : null;
}

function jsonLine(msg: string, text: string): number | null {
  const l = /line (\d+)/.exec(msg);
  if (l) return Number(l[1]);
  const p = /position (\d+)/.exec(msg);
  return p ? text.slice(0, Number(p[1])).split('\n').length : null;
}

const INSTALL_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
];
const BUILD_CONFIG =
  /^(?:[\w.-]*\.)?(?:config|rc)\.[cm]?[jt]s$|^(?:next|vite|webpack|rollup|babel|postcss|tailwind|eslint|jest|vitest)[\w.-]*\.[cm]?[jt]s$/;
const NET_IN_CONFIG =
  /\bchild_process\b|\bfetch\s*\(|\bhttps?\.(?:get|request)\b|require\(\s*['"]https?['"]\s*\)|\b(?:curl|wget)\b/;
const EVAL = /\beval\s*\(|\bnew\s+Function\s*\(/;
const REMOTE_DEP = /^(?:git(?:\+\w+)?:|github:|https?:|file:|link:|ssh:)/;

/** Static checks of ONE file. */
export function validateFile(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  if (isAgentSensitivePath(path))
    return [
      f('error', 'sensitive_path', path, null, 'a file that is never part of a project change'),
    ];
  if (text.length > VALIDATE_LIMITS.maxFileBytes)
    return [f('error', 'file_too_large', path, null, 'the file is too large to check')];
  if (text.trim() === '') out.push(f('warning', 'empty_file', path, null, 'the file is empty'));
  for (const s of scanForSecrets(text))
    out.push(
      f(
        'error',
        'secret_detected',
        path,
        text.slice(0, s.index).split('\n').length,
        'the file contains something that looks like a secret',
      ),
    );
  if (text.includes('NZCANARY-'))
    out.push(
      f('error', 'canary_detected', path, null, 'the file contains a platform canary token'),
    );
  const base = path.split('/').pop()!;
  if (path.endsWith('.json')) {
    try {
      const j = JSON.parse(text) as unknown;
      if (base === 'package.json' && j && typeof j === 'object') {
        const pj = j as Record<string, unknown>;
        const scripts =
          pj.scripts && typeof pj.scripts === 'object' ? Object.keys(pj.scripts as object) : [];
        for (const h of INSTALL_HOOKS)
          if (scripts.includes(h))
            out.push(
              f(
                'error',
                'install_script',
                path,
                null,
                'an install-time script is not allowed in a generated project',
              ),
            );
        for (const k of [
          'dependencies',
          'devDependencies',
          'optionalDependencies',
          'peerDependencies',
        ]) {
          const o = pj[k];
          if (o && typeof o === 'object')
            for (const v of Object.values(o as Record<string, unknown>))
              if (typeof v === 'string' && REMOTE_DEP.test(v)) {
                out.push(
                  f(
                    'error',
                    'remote_dependency',
                    path,
                    null,
                    'a dependency points at a URL, git repository or local path instead of a registry version',
                  ),
                );
                break;
              }
        }
        if (typeof pj.name !== 'string')
          out.push(f('warning', 'package_name_missing', path, null, 'package.json has no name'));
      }
    } catch (e) {
      out.push(
        f(
          'error',
          'invalid_json',
          path,
          jsonLine(String((e as Error).message), text),
          'the file is not valid JSON',
        ),
      );
    }
  } else if (isCodePath(path)) {
    const bp = bracketProblem(text);
    if (bp)
      out.push(
        f(
          'error',
          'unbalanced_brackets',
          path,
          bp.line,
          bp.kind === 'unclosed'
            ? 'a bracket is opened and never closed'
            : bp.kind === 'unexpected'
              ? 'a closing bracket has no opening one'
              : 'a closing bracket does not match the one opened',
        ),
      );
    if (EVAL.test(text))
      out.push(
        f(
          'warning',
          'dynamic_code',
          path,
          null,
          'dynamic code evaluation (eval or new Function) is used',
        ),
      );
    if (BUILD_CONFIG.test(base) && NET_IN_CONFIG.test(text))
      out.push(
        f(
          'error',
          'network_in_build_config',
          path,
          null,
          'build tooling must not start processes or make network calls',
        ),
      );
  } else if (path.endsWith('.css')) {
    const bp = bracketProblem(text, { css: true });
    if (bp) out.push(f('error', 'unbalanced_brackets', path, bp.line, 'a brace is not balanced'));
  }
  if (/lorem ipsum/i.test(text))
    out.push(f('warning', 'placeholder_text', path, null, 'placeholder text was left in the file'));
  return out;
}

/** Static checks of the whole project (or only `paths`), the import graph included. */
export function validateProject(
  files: ReadonlyMap<string, string>,
  opts: { paths?: ReadonlySet<string> } = {},
): Finding[] {
  const out: Finding[] = [];
  let n = 0;
  for (const [path, text] of files) {
    if (opts.paths && !opts.paths.has(path)) continue;
    if (++n > VALIDATE_LIMITS.maxFiles) {
      out.push(f('warning', 'too_many_files', null, null, 'only the first files were checked'));
      break;
    }
    out.push(...validateFile(path, text));
    if (out.length >= VALIDATE_LIMITS.maxFindings) break;
  }
  const imp = analyzeImports(files);
  for (const u of imp.unresolved)
    if (!opts.paths || opts.paths.has(u.path))
      out.push(
        f(
          'error',
          'unresolved_import',
          u.path,
          u.line,
          u.reason === 'outside_project'
            ? 'an import points outside the project'
            : 'an import does not match any project file',
        ),
      );
  for (const m of imp.missingPackages)
    if (!opts.paths || opts.paths.has(m.path))
      out.push(
        f(
          'warning',
          'undeclared_package',
          m.path,
          m.line,
          'a package is imported but not declared in package.json',
        ),
      );
  for (const c of imp.cycles)
    out.push(
      f(
        'warning',
        'import_cycle',
        c[0]!,
        null,
        `files import each other in a cycle (${c.length} files)`,
      ),
    );
  return out.slice(0, VALIDATE_LIMITS.maxFindings);
}

export interface ReviewSummary {
  passed: boolean;
  errors: number;
  warnings: number;
  infos: number;
}
export const summarize = (findings: readonly Finding[]): ReviewSummary => {
  const c = { error: 0, warning: 0, info: 0 };
  for (const x of findings) c[x.severity]++;
  return { passed: c.error === 0, errors: c.error, warnings: c.warning, infos: c.info };
};

/**
 * The review pass: static validation of the changed files (and the import graph around them) plus the plan's expectations: every file a finished task promised must exist.
 * `plan` is optional (a free-form edit has none).
 */
export function reviewProject(
  files: ReadonlyMap<string, string>,
  opts: {
    changedPaths?: ReadonlySet<string>;
    plan?: { tasks: readonly { id: string; files: readonly string[] }[] };
    doneTasks?: ReadonlySet<string>;
  } = {},
): { findings: Finding[]; summary: ReviewSummary } {
  const findings = validateProject(files, opts.changedPaths ? { paths: opts.changedPaths } : {});
  for (const t of opts.plan?.tasks ?? []) {
    if (opts.doneTasks && !opts.doneTasks.has(t.id)) continue;
    for (const p of t.files)
      if (!files.has(p))
        findings.push(
          f(
            'warning',
            'missing_planned_file',
            p,
            null,
            `task ${t.id} planned this file and it does not exist`,
          ),
        );
  }
  return { findings, summary: summarize(findings) };
}
