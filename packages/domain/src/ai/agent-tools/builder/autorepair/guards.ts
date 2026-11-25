import type { FileOp } from '../changeset';
import { isCodePath, parseImports, resolveImport } from '../code-intel';
import type { Diagnostic } from '../diagnose';

/**
 * Repair guards (P3-S03). A repair is accepted only when it fixes the problem AND keeps the project honest. Two independent checks run on every proposed set of operations, whoever
 * produced it (a deterministic fixer, a model, a person's script), BEFORE anything is applied:
 *
 *  - INTEGRITY: "green by cheating" is refused. A repair may not delete or skip a test, remove assertions, silence the type checker (`@ts-ignore`, `@ts-nocheck`, a flood of `any`),
 *    switch off a compiler or lint rule, or make a build script succeed whatever happens (`|| true`).
 *  - SCOPE: a repair touches the files the diagnostics name, the files next to them in the import graph, and the build configuration; it never deletes a file and never reaches a
 *    path a model could use to widen its task (CI config, migrations, secrets, deploy manifests).
 *
 * Both return reasons as fixed codes plus the path; they never quote file content, so a hostile file cannot smuggle text into a prompt through a violation.
 */
export type GuardCode =
  | 'test_deleted'
  | 'test_skipped'
  | 'assertions_removed'
  | 'type_check_silenced'
  | 'type_escape_flood'
  | 'strictness_lowered'
  | 'lint_silenced'
  | 'script_masked'
  | 'delete_not_allowed'
  | 'out_of_scope'
  | 'protected_path'
  | 'too_many_files';
export interface GuardViolation {
  code: GuardCode;
  path: string;
}

export const GUARD_LIMITS = {
  /** `any` introduced by ONE repair (casts and annotations together) */
  maxNewAny: 2,
  /** files one repair round may touch */
  maxFilesPerRound: 12,
} as const;

export const isTestPath = (p: string): boolean =>
  /(?:^|\/)(?:__tests__|tests?|e2e|integration_test)\//.test(p) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /_test\.dart$/.test(p) ||
  /(?:^|\/)src\/test\//.test(p);

export const isConfigPath = (p: string): boolean =>
  /(?:^|\/)(?:package\.json|tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|pubspec\.yaml|analysis_options\.yaml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?|postcss\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s)$/.test(
    p,
  );

/** paths a repair never touches: CI, migrations, deploy manifests, environment files, lockfiles and the project's own memory/instructions */
export const isProtectedPath = (p: string): boolean =>
  /^\.github\//.test(p) ||
  /(?:^|\/)\.gitlab-ci\.ya?ml$/.test(p) ||
  /(?:^|\/)(?:migrations?|db\/migrate)\//.test(p) ||
  /(?:^|\/)(?:Dockerfile|docker-compose[\w.-]*\.ya?ml|nuzm\.deploy\.[\w.]+|vercel\.json|netlify\.toml)$/.test(
    p,
  ) ||
  /(?:^|\/)\.env(?:\.[\w.-]+)?$/.test(p) ||
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pubspec\.lock|gradle\.lockfile)$/.test(
    p,
  ) ||
  /(?:^|\/)\.(?:npmrc|yarnrc|netrc)$/.test(p);

const count = (re: RegExp, s: string): number => (s.match(re) ?? []).length;
const ASSERT_RE = /\b(?:expect|assert(?:\.\w+)?|should|expectLater|verify)\s*\(/g;
const TEST_CASE_RE = /\b(?:it|test|testWidgets|testWidgets|group)\s*\(/g;
const SKIP_RE =
  /\b(?:it|test|describe|suite|xit|xtest|xdescribe)\.(?:skip|todo|fails)\b|\bx(?:it|test|describe)\s*\(|\bskip\s*:\s*(?:true|['"])|\bcontext\.skip\b|\bpending\s*\(/g;
const TS_SILENCE_RE =
  /@ts-(?:ignore|nocheck|expect-error)\b|\/\/\s*ignore(?:_for_file)?:\s*[\w,\s]+|\/\/\s*ignore_for_file\b/g;
const ANY_RE =
  /(?::\s*any\b|\bas\s+any\b|<any>|\bas\s+unknown\s+as\b|\bdynamic\b\s+[a-z_]\w*\s*[=;,)])/g;
const LINT_SILENCE_RE = /eslint-disable|\/\/\s*noinspection|\/\*\s*istanbul\s+ignore/g;

const FALSE_FLAGS = [
  'strict',
  'noImplicitAny',
  'strictNullChecks',
  'noUncheckedIndexedAccess',
  'noUnusedLocals',
  'noUnusedParameters',
  'noImplicitReturns',
];

function lowersStrictness(before: string, after: string): boolean {
  for (const k of FALSE_FLAGS) {
    const re = new RegExp(`"${k}"\\s*:\\s*(true|false)`);
    const b = re.exec(before)?.[1];
    const a = re.exec(after)?.[1];
    if (b === 'true' && a !== 'true') return true;
  }
  // an `include` that no longer lists the sources hides errors
  const inc = (s: string) => /"include"\s*:\s*\[([^\]]*)\]/.exec(s)?.[1]?.trim() ?? null;
  const bi = inc(before);
  const ai = inc(after);
  if (bi && ai !== null && ai.length < bi.length / 2) return true;
  return false;
}

function masksScripts(before: string, after: string): boolean {
  try {
    const b = (JSON.parse(before) as { scripts?: Record<string, string> }).scripts ?? {};
    const a = (JSON.parse(after) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [k, v] of Object.entries(a)) {
      if (typeof v !== 'string') continue;
      const masked =
        /(?:\|\|\s*(?:true|exit\s+0|:)\b)|(?:;\s*exit\s+0\b)|(?:^|\s)exit\s+0\s*$/.test(v) ||
        /--passWithNoTests\b/.test(v) ||
        /\bsuppress\b/i.test(v);
      const wasMasked =
        typeof b[k] === 'string' &&
        /(?:\|\|\s*(?:true|exit\s+0|:)\b)|(?:;\s*exit\s+0\b)/.test(b[k]!);
      if (masked && !wasMasked && /^(?:build|test|typecheck|lint|check|verify|compile)/.test(k))
        return true;
      // a build/test script that existed and was emptied or replaced by a no-op
      if (
        typeof b[k] === 'string' &&
        /^(?:build|test|typecheck)$/.test(k) &&
        /^(?:echo\b[^&|;]*|true|:|exit\s+0)$/.test(v.trim()) &&
        !/^(?:echo\b|true$|:$|exit\s+0$)/.test(b[k]!.trim())
      )
        return true;
    }
    // removing a test script entirely
    if (typeof b.test === 'string' && a.test === undefined) return true;
  } catch {
    /* an unreadable package.json is the JSON rule's business */
  }
  return false;
}

/**
 * Integrity check of a proposed repair against the project as it is NOW. `before` is the whole project; `ops` are the proposed operations (a `modify`/`add` carries the new full
 * content). Pure.
 */
export function checkIntegrity(
  before: ReadonlyMap<string, string>,
  ops: readonly FileOp[],
): GuardViolation[] {
  const v: GuardViolation[] = [];
  let newAny = 0;
  const flag = (code: GuardCode, path: string) => {
    if (!v.some((x) => x.code === code && x.path === path)) v.push({ code, path });
  };
  for (const o of ops) {
    const prev = before.get(o.path);
    if (o.op === 'delete') {
      if (isTestPath(o.path)) flag('test_deleted', o.path);
      continue;
    }
    if (o.op === 'rename') {
      if (isTestPath(o.path) || (o.from !== undefined && isTestPath(o.from)))
        flag('test_deleted', o.from ?? o.path);
      continue;
    }
    const next = o.content ?? '';
    const prevText = prev ?? '';
    if (isTestPath(o.path)) {
      if (count(SKIP_RE, next) > count(SKIP_RE, prevText)) flag('test_skipped', o.path);
      if (
        prev !== undefined &&
        (count(ASSERT_RE, next) < count(ASSERT_RE, prevText) ||
          count(TEST_CASE_RE, next) < count(TEST_CASE_RE, prevText))
      )
        flag('assertions_removed', o.path);
    }
    if (count(TS_SILENCE_RE, next) > count(TS_SILENCE_RE, prevText))
      flag('type_check_silenced', o.path);
    if (/(?:\.d\.ts|\.[cm]?[jt]sx?|\.dart)$/.test(o.path))
      newAny += Math.max(0, count(ANY_RE, next) - count(ANY_RE, prevText));
    if (count(LINT_SILENCE_RE, next) > count(LINT_SILENCE_RE, prevText))
      flag('lint_silenced', o.path);
    if (
      prev !== undefined &&
      /(?:^|\/)tsconfig(?:\.[\w-]+)?\.json$/.test(o.path) &&
      lowersStrictness(prevText, next)
    )
      flag('strictness_lowered', o.path);
    if (
      prev !== undefined &&
      /(?:^|\/)analysis_options\.yaml$/.test(o.path) &&
      /(?:^|\n)\s*(?:strict-casts|strict-inference|strict-raw-types)\s*:\s*false/.test(next) &&
      !/(?:strict-casts|strict-inference|strict-raw-types)\s*:\s*false/.test(prevText)
    )
      flag('strictness_lowered', o.path);
    if (prev !== undefined && /(?:^|\/)package\.json$/.test(o.path) && masksScripts(prevText, next))
      flag('script_masked', o.path);
  }
  if (newAny > GUARD_LIMITS.maxNewAny)
    flag('type_escape_flood', ops.find((o) => o.op !== 'delete')?.path ?? '');
  return v;
}

/** The files a repair may modify: those the diagnostics name, their direct imports and importers, and the build configuration (nothing else, nothing protected). */
export function repairScope(
  files: ReadonlyMap<string, string>,
  diagnostics: readonly Diagnostic[],
): { paths: Set<string>; unrestricted: boolean } {
  const named = new Set(
    diagnostics.map((d) => d.path).filter((p): p is string => !!p && files.has(p)),
  );
  if (named.size === 0) return { paths: new Set(), unrestricted: true };
  const paths = new Set<string>(named);
  for (const p of named) {
    const text = files.get(p)!;
    if (isCodePath(p))
      for (const i of parseImports(text)) {
        const r = resolveImport(p, i.spec, files);
        if (r.ok) paths.add(r.path);
      }
  }
  // importers of a named file (a fix to an export often has to follow the files that use it)
  for (const [p, text] of files) {
    if (paths.has(p) || !isCodePath(p)) continue;
    for (const i of parseImports(text)) {
      const r = resolveImport(p, i.spec, files);
      if (r.ok && named.has(r.path)) {
        paths.add(p);
        break;
      }
    }
  }
  return { paths, unrestricted: false };
}

/**
 * Scope check. With no file named by any diagnostic (a dependency that does not resolve, a bundler message without a location) the scope is `unrestricted` for source files, bounded by
 * the file limit and the protected-path rule: the model may then look for the cause itself, but never in CI, migrations, secrets or the lockfile.
 */
export function checkScope(
  files: ReadonlyMap<string, string>,
  diagnostics: readonly Diagnostic[],
  ops: readonly FileOp[],
): GuardViolation[] {
  const v: GuardViolation[] = [];
  const scope = repairScope(files, diagnostics);
  const touched = new Set(ops.map((o) => o.path));
  if (touched.size > GUARD_LIMITS.maxFilesPerRound) v.push({ code: 'too_many_files', path: '' });
  for (const o of ops) {
    if (o.op === 'delete' || o.op === 'rename') {
      if (!isTestPath(o.path)) v.push({ code: 'delete_not_allowed', path: o.path });
      continue;
    }
    if (isProtectedPath(o.path)) {
      v.push({ code: 'protected_path', path: o.path });
      continue;
    }
    if (isConfigPath(o.path)) continue;
    if (o.op === 'add') {
      // a new file next to a file in scope (a missing helper) is allowed; anywhere else is not
      const near = [...scope.paths].some(
        (p) => p.includes('/') && o.path.startsWith(`${p.slice(0, p.lastIndexOf('/'))}/`),
      );
      if (
        !scope.unrestricted &&
        !near &&
        scope.paths.size > 0 &&
        ![...scope.paths].some((p) => !p.includes('/'))
      )
        v.push({ code: 'out_of_scope', path: o.path });
      continue;
    }
    if (!scope.unrestricted && !scope.paths.has(o.path))
      v.push({ code: 'out_of_scope', path: o.path });
  }
  return v;
}

/** both checks, in one list */
export const checkRepair = (
  before: ReadonlyMap<string, string>,
  diagnostics: readonly Diagnostic[],
  ops: readonly FileOp[],
): GuardViolation[] => [...checkIntegrity(before, ops), ...checkScope(before, diagnostics, ops)];

/** a violation as a sentence for the NEXT model turn: fixed text, the code and the path only */
export const violationText = (v: GuardViolation): string => {
  const why: Record<GuardCode, string> = {
    test_deleted: 'a test must not be deleted or renamed away to make the build pass',
    test_skipped: 'a test must not be skipped, marked todo or expected to fail',
    assertions_removed:
      'assertions or test cases must not be removed; fix the code the test checks',
    type_check_silenced:
      'the type checker must not be silenced (@ts-ignore, @ts-nocheck, @ts-expect-error, ignore_for_file)',
    type_escape_flood:
      'do not escape the type system with `any`/`dynamic` casts; give the value its real type',
    strictness_lowered: 'compiler strictness must not be lowered',
    lint_silenced: 'lint rules must not be disabled',
    script_masked: 'a build or test script must not be made to succeed regardless of the result',
    delete_not_allowed: 'a repair edits files; it does not delete or rename them',
    out_of_scope: 'the file is not related to the reported problems',
    protected_path:
      'CI, migrations, deploy files, environment files and lockfiles are never changed by a repair',
    too_many_files: 'too many files for one repair round',
  };
  return `${v.code} (${v.path || 'project'}): ${why[v.code]}`;
};
