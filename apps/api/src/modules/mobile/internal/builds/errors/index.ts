import { parseDart } from './dart';
import { parseGradle } from './gradle';
import { parsePub } from './pub';
import { parseXcode } from './xcode';
import { cap, clean, dedupe, redact, scrubHostPaths } from './common';
import { MAX_ERRORS, type FixKind, type ParseResult, type ParsedBuildError } from './types';

export * from './types';
export { parseDart, parseGradle, parsePub, parseXcode };

export type BuildStage =
  'pub_get' | 'analyze' | 'test' | 'build_apk' | 'build_ios' | 'pod_install' | 'xcodebuild';
export interface ParseContext {
  stage?: BuildStage;
  /** absolute directories the tool may have printed as the project root; paths under them become project-relative */
  roots?: readonly string[];
  /** the project's own Dart package name (pubspec `name`): an import of it that does not resolve is a missing FILE, not a missing dependency */
  packageName?: string;
}

/**
 * Parse the output of one build stage. The stage selects the parsers (a Dart analyzer line is only expected from analyze/test/build; a Gradle block only from build_apk), but when
 * no stage is given every parser runs. Output is deterministic, capped, redacted, ordered root-cause first (environment, then dependency, then source).
 */
export function parseBuildOutput(raw: string, ctx: ParseContext = {}): ParseResult {
  const roots = ctx.roots ?? [];
  const text = scrubHostPaths(clean(raw), roots);
  const s = ctx.stage;
  const all: ParsedBuildError[] = [];
  if (!s || s === 'pub_get') all.push(...parsePub(text));
  if (!s || s === 'analyze' || s === 'test' || s === 'build_apk' || s === 'build_ios')
    all.push(...parseDart(text, roots, ctx.packageName));
  if (!s || s === 'build_apk') all.push(...parseGradle(text, roots));
  if (!s || s === 'build_ios' || s === 'pod_install' || s === 'xcodebuild')
    all.push(...parseXcode(text, roots));
  const tail = cap(
    text
      .split('\n')
      .filter((l) => l.trim())
      .slice(-12)
      .map(redact)
      .join('\n'),
    1500,
  );
  const errors = order(dedupe(all)).slice(0, MAX_ERRORS);
  // a stage that FAILED but produced nothing recognisable must never look clean: the caller passes the exit code
  return { errors, clean: errors.filter((e) => e.severity === 'error').length === 0, tail };
}

const RANK: Record<FixKind, number> = {
  environment: 0,
  regenerate_platform: 1,
  retry: 2,
  edit_android_config: 3,
  edit_ios_config: 3,
  edit_pubspec: 4,
  edit_source: 5,
  none: 6,
};
const order = (list: ParsedBuildError[]): ParsedBuildError[] =>
  [...list].sort(
    (a, b) =>
      RANK[a.fix] - RANK[b.fix] ||
      (a.file ?? '').localeCompare(b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0),
  );

/** the failed stage's result for the repair loop: the errors, or one `unknown` error built from the tail when the log shows nothing recognisable */
export function failureFromStage(
  raw: string,
  exitCode: number | null,
  ctx: ParseContext = {},
): ParseResult {
  const r = parseBuildOutput(raw, ctx);
  if (exitCode === 0 || r.errors.some((e) => e.severity === 'error')) return r;
  const e: ParsedBuildError = {
    tool: 'unknown',
    errorClass: 'unknown',
    severity: 'error',
    message: `stage ${ctx.stage ?? 'build'} failed (exit ${String(exitCode)}) without a recognisable error`,
    fix: 'none',
    targetFiles: [],
    hint: 'Unrecognised failure. Show the tail to the model once; if it cannot name a project-level cause, stop and report.',
    excerpt: r.tail,
  };
  return { errors: [e], clean: false, tail: r.tail };
}

export type RepairAction =
  'stop_environment' | 'retry' | 'regenerate_platform' | 'model_patch' | 'stop_unknown';
/**
 * What the repair loop should do with a parse result, by the highest-priority error. `stop_environment` is final: the project cannot be repaired by a patch and the loop must not try
 * (a "repair" that hides an environment fault would be a false green).
 */
export function repairAction(r: ParseResult): { action: RepairAction; errors: ParsedBuildError[] } {
  const errs = r.errors.filter((e) => e.severity === 'error');
  const first = errs[0];
  if (!first) return { action: 'stop_unknown', errors: [] };
  const same = (k: FixKind) => errs.filter((e) => e.fix === k);
  switch (first.fix) {
    case 'environment':
      return { action: 'stop_environment', errors: same('environment') };
    case 'regenerate_platform':
      return { action: 'regenerate_platform', errors: same('regenerate_platform') };
    case 'retry':
      return { action: 'retry', errors: same('retry') };
    case 'none':
      return { action: 'stop_unknown', errors: errs };
    default:
      return {
        action: 'model_patch',
        errors: errs.filter(
          (e) => !['environment', 'retry', 'regenerate_platform', 'none'].includes(e.fix),
        ),
      };
  }
}
