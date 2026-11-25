import { scanForSecrets } from '../../secret-scan';
import { isAgentSensitivePath, normalizeToolPath } from '../paths';
import { sha256Hex } from './sha256';
import { applyHunks, diffFile, parseUnifiedDiff, type Hunk } from './diff';

/**
 * Change sets, dry-run previews and rollback plans (S-05 priority 1). Pure functions over an in-memory snapshot: nothing is written, run or fetched here. A preview answers "what
 * WOULD happen if this change set were applied", with the exact per-file diffs, the risks and whether a human must approve; the API layer applies a change set only through
 * the existing safe-change pipeline (`ChangeService`), which re-checks everything.
 */
export { sha256Hex };

export type FileOpKind = 'add' | 'modify' | 'delete' | 'rename';
/** The same shape as the existing safe-change patch (`ChangeService.Patch`). */
export interface FileOp {
  op: FileOpKind;
  path: string;
  /** add / modify: the full new content */
  content?: string;
  /** rename: the old path */
  from?: string;
  /** modify / delete / rename: sha256 of the content the op was written against */
  expectedHash?: string;
}

export const CHANGESET_LIMITS = {
  maxOps: 200,
  maxTotalBytes: 5_000_000,
  maxFileBytes: 1_000_000,
  maxProjectFiles: 5_000,
  /** per-file diff text kept in a preview; longer is cut and says so */
  maxDiffCharsPerFile: 20_000,
  maxDiffCharsTotal: 200_000,
  /** a change at or above these needs a human's approval */
  approvalDeletes: 10,
  approvalFiles: 40,
} as const;

export type PreviewErrorCode =
  | 'invalid_op'
  | 'invalid_path'
  | 'sensitive_path'
  | 'duplicate_path'
  | 'already_exists'
  | 'not_found'
  | 'base_mismatch'
  | 'too_large'
  | 'secret_detected'
  | 'canary_detected'
  | 'too_many_ops'
  | 'too_many_files'
  | 'invalid_manifest'
  | 'hunk_context_mismatch'
  | 'hunk_ambiguous'
  | 'hunk_out_of_range'
  | 'hunks_overlap'
  | 'invalid_diff';
export interface PreviewError {
  /** `ops[i]` or a file path */
  at: string;
  code: PreviewErrorCode;
  /** fixed text: it never quotes file content or an argument */
  message: string;
}

export type RiskCode =
  | 'deletes_many_files'
  | 'edits_applied_migration'
  | 'changes_dependencies'
  | 'changes_deploy_manifest'
  | 'removes_tests'
  | 'large_change'
  | 'touches_build_config'
  | 'touches_ci_config';
export interface Risk {
  code: RiskCode;
  message: string;
}

export interface PreviewFile {
  op: FileOpKind;
  path: string;
  from?: string;
  bytesBefore: number;
  bytesAfter: number;
  added: number;
  removed: number;
  /** unified diff text, possibly cut at `maxDiffCharsPerFile` */
  diff: string;
  diffTruncated: boolean;
  /** the hash a later op on this file should carry as `expectedHash` */
  hashBefore: string | null;
}
export interface ChangePreview {
  ok: boolean;
  errors: PreviewError[];
  files: PreviewFile[];
  totals: { files: number; added: number; removed: number };
  risks: Risk[];
  approval: { required: boolean; reasons: string[] };
  /** present only when `ok`: the project after the change (for validation passes and the next preview) */
  next?: Map<string, string>;
}

const MIGRATION = /^db\/migrations\/.+\.sql$/;
const BUILD_CONFIG =
  /^(vite|webpack|rollup|next|tsconfig|babel|eslint|postcss|tailwind)[^/]*\.(config\.)?(c|m)?(js|ts|json)$|^tsconfig[^/]*\.json$/;
const CI_CONFIG =
  /^(\.github\/workflows\/|\.gitlab-ci\.yml$|Dockerfile$|docker-compose[^/]*\.ya?ml$)/;

const RESERVED_TOP = new Set([
  '.git',
  '.nuzm',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config',
  'node_modules',
]);
/**
 * The path rules of the change pipeline that `normalizeToolPath` does not already enforce (reserved top-level directories, reserved characters, a segment ending in a space or a dot,
 * the 240-character limit), so a preview never says "ok" about a path the pipeline will refuse.
 */
export function projectPathProblem(path: string): string | null {
  if (path.length > 240) return 'too_long';
  const segs = path.split('/');
  if (RESERVED_TOP.has(segs[0]!.toLowerCase())) return 'reserved_directory';
  for (const s of segs) {
    if (/[:*?"<>|]/.test(s)) return 'reserved_character';
    if (/[ .]$/.test(s)) return 'trailing_space_or_dot';
    if (/^\.+$/.test(s)) return 'dot_segment';
  }
  return null;
}

export interface PreviewOptions {
  /** exact platform strings that must never appear in a project file */
  canaries?: readonly string[];
  /** the project already has a version (editing an applied migration is a risk only then) */
  hasHead?: boolean;
}

/**
 * Dry-runs a change set on `base`. Every op is validated as the real pipeline will validate it (paths, sensitive names, secrets, canaries, sizes, existence, base hashes) and the
 * per-file diffs are rendered. Nothing is applied: `next` is a new map.
 */
export function previewChangeSet(
  base: ReadonlyMap<string, string>,
  ops: unknown,
  opts: PreviewOptions = {},
): ChangePreview {
  const errors: PreviewError[] = [];
  const empty = (): ChangePreview => ({
    ok: false,
    errors,
    files: [],
    totals: { files: 0, added: 0, removed: 0 },
    risks: [],
    approval: { required: false, reasons: [] },
  });
  if (!Array.isArray(ops) || ops.length === 0) {
    errors.push({
      at: 'ops',
      code: 'invalid_op',
      message: 'a non-empty list of operations is required',
    });
    return empty();
  }
  if (ops.length > CHANGESET_LIMITS.maxOps) {
    errors.push({
      at: 'ops',
      code: 'too_many_ops',
      message: `at most ${CHANGESET_LIMITS.maxOps} operations per change`,
    });
    return empty();
  }
  const next = new Map(base);
  const files: PreviewFile[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let diffBudget: number = CHANGESET_LIMITS.maxDiffCharsTotal;
  const touched: { op: FileOpKind; path: string; from?: string }[] = [];

  const pathOk = (at: string, p: unknown): string | null => {
    const r = normalizeToolPath(p);
    if (!r.ok) {
      errors.push({
        at,
        code: 'invalid_path',
        message: 'the path is not a valid relative project path',
      });
      return null;
    }
    if (projectPathProblem(r.path)) {
      errors.push({
        at,
        code: 'invalid_path',
        message: 'the path is not a valid relative project path',
      });
      return null;
    }
    if (isAgentSensitivePath(r.path)) {
      errors.push({
        at,
        code: 'sensitive_path',
        message: 'this path is never changed by an agent',
      });
      return null;
    }
    return r.path;
  };
  const contentOk = (at: string, text: unknown): string | null => {
    if (typeof text !== 'string') {
      errors.push({ at, code: 'invalid_op', message: 'content (text) is required' });
      return null;
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > CHANGESET_LIMITS.maxFileBytes) {
      errors.push({
        at,
        code: 'too_large',
        message: `a file is larger than ${CHANGESET_LIMITS.maxFileBytes} bytes`,
      });
      return null;
    }
    bytes += size;
    if (scanForSecrets(text, opts.canaries ?? []).length) {
      errors.push({
        at,
        code: 'secret_detected',
        message: 'the content matches a secret or canary pattern',
      });
      return null;
    }
    if (text.includes('NZCANARY-')) {
      errors.push({
        at,
        code: 'canary_detected',
        message: 'the content contains a platform canary token',
      });
      return null;
    }
    return text;
  };
  const claim = (at: string, p: string): boolean => {
    if (seen.has(p)) {
      errors.push({
        at,
        code: 'duplicate_path',
        message: 'a path is changed twice in one change set',
      });
      return false;
    }
    seen.add(p);
    return true;
  };

  ops.forEach((raw, i) => {
    const at = `ops[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      errors.push({ at, code: 'invalid_op', message: 'an operation must be an object' });
      return;
    }
    const o = raw as Partial<FileOp>;
    if (!['add', 'modify', 'delete', 'rename'].includes(o.op as string)) {
      errors.push({ at, code: 'invalid_op', message: 'op must be add, modify, delete or rename' });
      return;
    }
    if (
      o.expectedHash !== undefined &&
      !(typeof o.expectedHash === 'string' && /^[0-9a-f]{64}$/.test(o.expectedHash))
    ) {
      errors.push({ at, code: 'invalid_op', message: 'expectedHash must be a sha256 hex' });
      return;
    }
    const path = pathOk(`${at}.path`, o.path);
    if (path === null) return;
    const checkBase = (p: string, cur: string): boolean => {
      if (o.expectedHash !== undefined && o.expectedHash !== sha256Hex(cur)) {
        errors.push({
          at: p,
          code: 'base_mismatch',
          message: 'the file changed since the operation was written',
        });
        return false;
      }
      return true;
    };
    if (o.op === 'add') {
      const text = contentOk(`${at}.content`, o.content);
      if (text === null || !claim(`${at}.path`, path)) return;
      if (next.has(path)) {
        errors.push({ at: path, code: 'already_exists', message: 'the file already exists' });
        return;
      }
      next.set(path, text);
      const d = diffFile(null, null, path, text);
      files.push(entry('add', path, undefined, '', text, d, undefined));
      touched.push({ op: 'add', path });
    } else if (o.op === 'modify') {
      const text = contentOk(`${at}.content`, o.content);
      if (text === null || !claim(`${at}.path`, path)) return;
      const cur = next.get(path);
      if (cur === undefined) {
        errors.push({ at: path, code: 'not_found', message: 'the file does not exist' });
        return;
      }
      if (!checkBase(path, cur)) return;
      next.set(path, text);
      const d = diffFile(path, cur, path, text);
      files.push(entry('modify', path, undefined, cur, text, d, sha256Hex(cur)));
      touched.push({ op: 'modify', path });
    } else if (o.op === 'delete') {
      if (o.content !== undefined) {
        errors.push({
          at: `${at}.content`,
          code: 'invalid_op',
          message: 'a delete carries no content',
        });
        return;
      }
      if (!claim(`${at}.path`, path)) return;
      const cur = next.get(path);
      if (cur === undefined) {
        errors.push({ at: path, code: 'not_found', message: 'the file does not exist' });
        return;
      }
      if (!checkBase(path, cur)) return;
      next.delete(path);
      const d = diffFile(path, cur, null, null);
      files.push(entry('delete', path, undefined, cur, '', d, sha256Hex(cur)));
      touched.push({ op: 'delete', path });
    } else {
      const from = pathOk(`${at}.from`, o.from);
      if (from === null || !claim(`${at}.path`, path) || !claim(`${at}.from`, from)) return;
      const cur = next.get(from);
      if (cur === undefined) {
        errors.push({ at: from, code: 'not_found', message: 'the file to rename does not exist' });
        return;
      }
      if (next.has(path)) {
        errors.push({ at: path, code: 'already_exists', message: 'the target already exists' });
        return;
      }
      if (!checkBase(from, cur)) return;
      next.delete(from);
      next.set(path, cur);
      const d = diffFile(from, cur, path, cur);
      files.push(entry('rename', path, from, cur, cur, d, sha256Hex(cur)));
      touched.push({ op: 'rename', path, from });
    }
  });

  if (bytes > CHANGESET_LIMITS.maxTotalBytes)
    errors.push({
      at: 'ops',
      code: 'too_large',
      message: `more than ${CHANGESET_LIMITS.maxTotalBytes} bytes in one change`,
    });
  if (next.size > CHANGESET_LIMITS.maxProjectFiles)
    errors.push({
      at: 'ops',
      code: 'too_many_files',
      message: `a project may have at most ${CHANGESET_LIMITS.maxProjectFiles} files`,
    });
  const pkgBefore = base.get('package.json');
  const pkgAfter = next.get('package.json');
  if (errors.length === 0 && pkgAfter !== undefined && pkgAfter !== pkgBefore) {
    try {
      JSON.parse(pkgAfter);
    } catch {
      errors.push({
        at: 'package.json',
        code: 'invalid_manifest',
        message: 'package.json is not valid JSON',
      });
    }
  }

  const totals = files.reduce(
    (t, f) => ({ files: t.files + 1, added: t.added + f.added, removed: t.removed + f.removed }),
    { files: 0, added: 0, removed: 0 },
  );
  const risks = errors.length === 0 ? riskOf(touched, base, next, opts) : [];
  const approval = approvalOf(touched, risks);
  const preview: ChangePreview = {
    ok: errors.length === 0,
    errors,
    files,
    totals,
    risks,
    approval,
  };
  if (preview.ok) preview.next = next;
  return preview;

  function entry(
    op: FileOpKind,
    path: string,
    from: string | undefined,
    before: string,
    after: string,
    d: ReturnType<typeof diffFile>,
    hashBefore: string | undefined,
  ): PreviewFile {
    const room = Math.max(0, Math.min(CHANGESET_LIMITS.maxDiffCharsPerFile, diffBudget));
    const cut = d.text.length > room;
    const text = cut ? d.text.slice(0, room) : d.text;
    diffBudget -= text.length;
    return {
      op,
      path,
      ...(from !== undefined ? { from } : {}),
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(after, 'utf8'),
      added: d.stats.added,
      removed: d.stats.removed,
      diff: text,
      diffTruncated: cut,
      hashBefore: hashBefore ?? null,
    };
  }
}

function riskOf(
  touched: readonly { op: FileOpKind; path: string; from?: string }[],
  base: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  opts: PreviewOptions,
): Risk[] {
  const risks: Risk[] = [];
  const deleted = touched.filter((t) => t.op === 'delete').map((t) => t.path);
  const modOrDel = touched.filter((t) => t.op === 'modify' || t.op === 'delete').map((t) => t.path);
  const addOrMod = touched.filter((t) => t.op === 'add' || t.op === 'modify').map((t) => t.path);
  if (deleted.length >= CHANGESET_LIMITS.approvalDeletes)
    risks.push({ code: 'deletes_many_files', message: `${deleted.length} files are deleted` });
  if (opts.hasHead !== false && modOrDel.some((p) => MIGRATION.test(p)))
    risks.push({
      code: 'edits_applied_migration',
      message:
        'an existing migration is edited or deleted: migrations are forward-only, add a new one instead',
    });
  if (modOrDel.some((p) => p.startsWith('tests/') || /\.(spec|test)\.[cm]?[jt]sx?$/.test(p)))
    risks.push({ code: 'removes_tests', message: 'tests are modified or deleted' });
  if (addOrMod.includes('nuzm.app.json'))
    risks.push({
      code: 'changes_deploy_manifest',
      message: 'the run, build and deploy commands change',
    });
  if (next.get('package.json') !== base.get('package.json'))
    risks.push({
      code: 'changes_dependencies',
      message: 'dependencies or scripts change: the lockfile must be regenerated and scanned',
    });
  if (touched.some((t) => BUILD_CONFIG.test(t.path) && !t.path.includes('/')))
    risks.push({
      code: 'touches_build_config',
      message: 'a build or compiler configuration changes',
    });
  if (touched.some((t) => CI_CONFIG.test(t.path)))
    risks.push({
      code: 'touches_ci_config',
      message: 'a pipeline or container definition changes',
    });
  if (touched.length >= CHANGESET_LIMITS.approvalFiles)
    risks.push({ code: 'large_change', message: `${touched.length} files change at once` });
  return risks;
}

const APPROVAL_RISKS: ReadonlySet<RiskCode> = new Set([
  'deletes_many_files',
  'edits_applied_migration',
  'changes_deploy_manifest',
  'touches_ci_config',
  'large_change',
]);
function approvalOf(
  _touched: readonly unknown[],
  risks: readonly Risk[],
): { required: boolean; reasons: string[] } {
  const reasons = risks.filter((r) => APPROVAL_RISKS.has(r.code)).map((r) => r.code);
  return { required: reasons.length > 0, reasons };
}

// ───────────────────────── unified diff → change set ─────────────────────────

export type DiffToOps =
  { ok: true; ops: FileOp[]; drift: number } | { ok: false; errors: PreviewError[] };

/**
 * Turns a unified diff (the compact way for a model to propose an edit) into whole-file ops against `base`, with the base hash of every touched file so the pipeline can detect a
 * file that changed in between. The diff is parsed and every hunk is matched against the real file content (see `applyHunks`); one failing hunk fails the whole diff.
 */
export function opsFromUnifiedDiff(base: ReadonlyMap<string, string>, diffText: string): DiffToOps {
  const parsed = parseUnifiedDiff(diffText);
  if (!parsed.ok)
    return {
      ok: false,
      errors: parsed.errors.map((message) => ({
        at: 'diff',
        code: 'invalid_diff',
        message: message.slice(0, 200),
      })),
    };
  const ops: FileOp[] = [];
  const errors: PreviewError[] = [];
  let drift = 0;
  parsed.files.forEach((f, i) => {
    const at = `diff.files[${i}]`;
    const target = f.newPath ?? f.oldPath!;
    const tp = normalizeToolPath(target);
    const fp = f.oldPath === null ? null : normalizeToolPath(f.oldPath);
    if (!tp.ok || (fp !== null && !fp.ok)) {
      errors.push({
        at,
        code: 'invalid_path',
        message: 'the path is not a valid relative project path',
      });
      return;
    }
    const joined = (hs: Hunk[]) => hs;
    if (f.oldPath === null) {
      // new file: every hunk line is an insertion
      const text = f.hunks
        .flatMap((h) => h.lines.filter((l) => l.kind === 'ins').map((l) => l.text))
        .join('');
      ops.push({ op: 'add', path: tp.path, content: text });
      return;
    }
    const oldPath = (fp as { ok: true; path: string }).path;
    const cur = base.get(oldPath);
    if (cur === undefined) {
      errors.push({ at, code: 'not_found', message: 'the file the diff changes does not exist' });
      return;
    }
    if (f.newPath === null) {
      ops.push({ op: 'delete', path: oldPath, expectedHash: sha256Hex(cur) });
      return;
    }
    const applied = f.hunks.length
      ? applyHunks(cur, joined(f.hunks))
      : ({ ok: true, text: cur, drift: [] } as const);
    if (!applied.ok) {
      errors.push({
        at,
        code: applied.error.code,
        message: `hunk ${applied.error.hunk + 1} does not apply to the current file`,
      });
      return;
    }
    drift += applied.drift.reduce((a, b) => a + b, 0);
    if (oldPath !== tp.path) {
      ops.push({ op: 'rename', path: tp.path, from: oldPath, expectedHash: sha256Hex(cur) });
      if (applied.text !== cur) {
        // a rename with edits: the pipeline's ops are one per path, so the edit is a follow-up the caller applies after the rename
        errors.push({
          at,
          code: 'invalid_diff',
          message:
            'a rename with edits in one file diff is not supported: send the rename and the edit as two steps',
        });
      }
    } else if (applied.text !== cur) {
      ops.push({
        op: 'modify',
        path: oldPath,
        content: applied.text,
        expectedHash: sha256Hex(cur),
      });
    }
  });
  if (errors.length) return { ok: false, errors };
  if (ops.length === 0)
    return {
      ok: false,
      errors: [{ at: 'diff', code: 'invalid_diff', message: 'the diff changes nothing' }],
    };
  return { ok: true, ops, drift };
}

// ───────────────────────── rollback / revert plans ─────────────────────────

/**
 * The operations that turn `current` into `target` (restore a version, or undo a whole change by restoring the version before it). Every modify/delete carries the hash of the
 * CURRENT file, so a restore racing with another change is refused instead of overwriting it. Sensitive paths are never produced.
 */
export function planRestore(
  current: ReadonlyMap<string, string>,
  target: ReadonlyMap<string, string>,
): FileOp[] {
  const ops: FileOp[] = [];
  for (const [path, cur] of [...current].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isAgentSensitivePath(path)) continue;
    const want = target.get(path);
    if (want === undefined) ops.push({ op: 'delete', path, expectedHash: sha256Hex(cur) });
    else if (want !== cur)
      ops.push({ op: 'modify', path, content: want, expectedHash: sha256Hex(cur) });
  }
  for (const [path, want] of [...target].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (isAgentSensitivePath(path)) continue;
    if (!current.has(path)) ops.push({ op: 'add', path, content: want });
  }
  return ops;
}

export interface RevertPlan {
  ops: FileOp[];
  /** files the change touched that were modified AFTER it: reverting them would lose the later work, so they are left alone and reported */
  conflicts: string[];
}

/**
 * Undoes ONE earlier change while keeping later work: for each file the change touched (`before` -> `after`), the file goes back to its `before` state only if it still equals
 * its `after` state in `current`; otherwise it is reported as a conflict and untouched.
 */
export function planRevert(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): RevertPlan {
  const paths = new Set<string>();
  for (const p of before.keys()) if (after.get(p) !== before.get(p)) paths.add(p);
  for (const p of after.keys()) if (before.get(p) !== after.get(p)) paths.add(p);
  const ops: FileOp[] = [];
  const conflicts: string[] = [];
  for (const path of [...paths].sort()) {
    if (isAgentSensitivePath(path)) continue;
    const was = before.get(path);
    const became = after.get(path);
    const now = current.get(path);
    if (now !== became) {
      conflicts.push(path);
      continue;
    }
    if (was === undefined && now !== undefined)
      ops.push({ op: 'delete', path, expectedHash: sha256Hex(now) });
    else if (was !== undefined && now === undefined) ops.push({ op: 'add', path, content: was });
    else if (was !== undefined && now !== undefined)
      ops.push({ op: 'modify', path, content: was, expectedHash: sha256Hex(now) });
  }
  return { ops, conflicts };
}
