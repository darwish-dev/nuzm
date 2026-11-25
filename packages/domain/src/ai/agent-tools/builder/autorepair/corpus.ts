import type { ErrorClass } from './classes';

/**
 * The repair STRATEGY CORPUS (P3-S03): for every error class, how a repair is attempted, in what order, what it must avoid and how much context it needs. It is DATA (reviewed,
 * versioned, evaluated offline against recorded logs) rather than prompt text scattered through code. `mechanical` names the deterministic fixers tried first (they cost no
 * tokens); `guidance` is the trusted instruction a model receives for the class; `context` says which extra project facts accompany the diagnostics.
 *
 * Nothing in the corpus is a claim about model quality: the offline evaluation measures the engine around the model (parsing, guards, rounds), and the live evaluation (a real
 * model, a real runtime) is a separate, labelled run.
 */
export interface StrategyEntry {
  class: ErrorClass;
  title: string;
  /** fixer ids tried before any model turn */
  mechanical: readonly string[];
  /** trusted instruction text for the model turn (English; the model answers in code) */
  guidance: string;
  /** extra facts the model message carries (as data): exporters of the missing name, the module that lacks an export, files the failing test imports, nearby paths */
  context: readonly (
    'exporters' | 'target_module' | 'code_under_test' | 'nearby_paths' | 'package_manifest'
  )[];
  /** what the model must not do for this class (shown to the model, and enforced by the guards where checkable) */
  avoid: readonly string[];
  /** typical size of a repair, used as a cap on operations */
  maxOps: number;
  risk: 'low' | 'medium' | 'high';
}

const common = [
  'Do not delete, skip or weaken tests.',
  'Do not use @ts-ignore, @ts-nocheck, @ts-expect-error or `any` casts to hide an error.',
  'Change only what the reported problems need.',
];

const E = (e: StrategyEntry): StrategyEntry => e;

export const STRATEGY_CORPUS: Readonly<Record<ErrorClass, StrategyEntry>> = {
  type_mismatch: E({
    class: 'type_mismatch',
    title: 'A value or annotation has the wrong type',
    mechanical: [],
    guidance:
      'Fix the type at its source: correct the value, the annotation or the function signature so both sides agree. Prefer changing the narrowest thing (one expression) over widening a type. If a caller and a callee disagree, decide which side is wrong from how the rest of the project uses it.',
    context: ['nearby_paths'],
    avoid: [...common, 'Do not widen a type to `any` or `unknown` to make it compile.'],
    maxOps: 4,
    risk: 'low',
  }),
  missing_property: E({
    class: 'missing_property',
    title: 'A property or method does not exist on a type',
    mechanical: [],
    guidance:
      'Either the property name is wrong (use the one the type declares) or the type is missing the property (add it where the type is declared, and keep every implementer consistent). Check the declaration before choosing.',
    context: ['target_module'],
    avoid: [...common],
    maxOps: 4,
    risk: 'low',
  }),
  null_safety: E({
    class: 'null_safety',
    title: 'A value may be null or undefined',
    mechanical: [],
    guidance:
      'Handle the empty case where the value is used: narrow it with a check, give it a default, or make the declaration non-optional if it is always set. Do not use the non-null assertion operator to silence the checker unless the code just before proves the value exists.',
    context: [],
    avoid: [...common],
    maxOps: 3,
    risk: 'low',
  }),
  call_signature: E({
    class: 'call_signature',
    title: 'A call has the wrong arguments',
    mechanical: [],
    guidance:
      'Make the call match the declared signature (count, order, types), or change the declaration and every other caller together if the declaration is what is wrong. Read the declaration first.',
    context: ['target_module'],
    avoid: [...common],
    maxOps: 4,
    risk: 'low',
  }),
  undefined_name: E({
    class: 'undefined_name',
    title: 'A name is used but not defined or imported',
    mechanical: ['add_missing_import'],
    guidance:
      'The name is either missing an import (when the data lists a project file that exports it, import it from there) or misspelled (use the name the project defines) or never defined (define it where the code needs it). Never import from a path you have not been shown.',
    context: ['exporters', 'nearby_paths'],
    avoid: [...common, 'Do not invent a package or a module path.'],
    maxOps: 4,
    risk: 'low',
  }),
  implicit_any: E({
    class: 'implicit_any',
    title: 'A value has an implicit any type',
    mechanical: [],
    guidance:
      'Give the parameter or variable its real type, taken from how it is used or from the declaration it is passed to. A named interface is better than an inline guess.',
    context: [],
    avoid: [...common],
    maxOps: 4,
    risk: 'low',
  }),
  duplicate_declaration: E({
    class: 'duplicate_declaration',
    title: 'A name is declared twice',
    mechanical: [],
    guidance:
      'Keep one declaration. If both are needed, rename one and update its uses; if one is a copy of the other, delete the copy and keep its uses working.',
    context: ['nearby_paths'],
    avoid: [...common],
    maxOps: 3,
    risk: 'low',
  }),
  missing_module: E({
    class: 'missing_module',
    title: 'A relative import points at a file that does not exist',
    mechanical: ['rewrite_relative_import'],
    guidance:
      'The import path is wrong or the file was never written. If the data lists a project file with that name, correct the path. If no file should exist there, create the missing file with the exports its importers use, written to match them.',
    context: ['nearby_paths', 'exporters'],
    avoid: [...common, 'Do not point the import at a file that merely has a similar purpose.'],
    maxOps: 4,
    risk: 'low',
  }),
  missing_package: E({
    class: 'missing_package',
    title: 'A package is imported but not installed',
    mechanical: ['copy_sibling_dependency'],
    guidance:
      'Prefer removing the dependency: use a platform API or a package the project already declares. Add a new package to package.json only if the feature cannot reasonably be built without it; then use the version range the project already uses for related packages, never a guessed one. A new dependency needs a person to approve it.',
    context: ['package_manifest'],
    avoid: [...common, 'Do not invent a package name or a version.'],
    maxOps: 3,
    risk: 'medium',
  }),
  missing_export: E({
    class: 'missing_export',
    title: 'An import names something the module does not export',
    mechanical: ['export_declared_symbol'],
    guidance:
      'Check the module the data shows: export the symbol if it is declared there, or import the name the module really exports, or import it from the file that exports it.',
    context: ['target_module', 'exporters'],
    avoid: [...common],
    maxOps: 3,
    risk: 'low',
  }),
  unused_symbol: E({
    class: 'unused_symbol',
    title: 'An import or variable is never used',
    mechanical: ['remove_unused_import'],
    guidance:
      'Remove the unused import or variable. If the value was meant to be used, use it where the surrounding code clearly needs it.',
    context: [],
    avoid: [...common],
    maxOps: 3,
    risk: 'low',
  }),
  syntax_error: E({
    class: 'syntax_error',
    title: 'The file does not parse',
    mechanical: [],
    guidance:
      'Repair the syntax at the reported line (an unclosed bracket, a missing comma or quote, a stray token). Keep the surrounding code as it is.',
    context: [],
    avoid: [...common, 'Do not rewrite the whole file when a line is wrong.'],
    maxOps: 2,
    risk: 'low',
  }),
  config_error: E({
    class: 'config_error',
    title: 'A build configuration file is wrong',
    mechanical: [],
    guidance:
      'Repair the configuration so the tool can read it (valid JSON, existing paths, supported options). Do not lower strictness to get past it.',
    context: ['package_manifest'],
    avoid: [...common, 'Do not lower compiler strictness.'],
    maxOps: 2,
    risk: 'medium',
  }),
  test_assertion: E({
    class: 'test_assertion',
    title: 'A test expects a different result',
    mechanical: [],
    guidance:
      'Decide from the requirement and the test name which side is wrong. Normally the code under test is wrong: fix it so the expected behaviour holds. Change a test only when its expectation contradicts the stated requirement, and then change the expected value, never remove the assertion.',
    context: ['code_under_test'],
    avoid: [...common, 'Do not change the expected value merely to match the current output.'],
    maxOps: 3,
    risk: 'high',
  }),
  test_runtime_error: E({
    class: 'test_runtime_error',
    title: 'A test throws while it runs',
    mechanical: [],
    guidance:
      'Find the call that throws (a function that is not exported, an undefined value, a wrong argument) and fix the code under test so the scenario works.',
    context: ['code_under_test'],
    avoid: [...common],
    maxOps: 3,
    risk: 'medium',
  }),
  lint: E({
    class: 'lint',
    title: 'A lint rule is violated',
    mechanical: [],
    guidance: 'Change the code so it follows the rule. Do not disable the rule.',
    context: [],
    avoid: [...common, 'Do not add eslint-disable comments.'],
    maxOps: 3,
    risk: 'low',
  }),
  dependency_resolution: E({
    class: 'dependency_resolution',
    title: 'A dependency cannot be resolved',
    mechanical: [],
    guidance:
      'Use only dependencies and versions the project already uses elsewhere, or remove the dependency. A dependency change needs a person to approve it; keep it to the minimum.',
    context: ['package_manifest'],
    avoid: [...common, 'Do not invent a dependency version or a repository.'],
    maxOps: 2,
    risk: 'high',
  }),
  native_compile: E({
    class: 'native_compile',
    title: 'A native (Android/Kotlin/Java) compile error',
    mechanical: [],
    guidance:
      'Fix the reported source line: a missing import, a wrong type or an undefined reference. Keep the project structure as it is.',
    context: ['nearby_paths'],
    avoid: [...common],
    maxOps: 3,
    risk: 'medium',
  }),
  build_tool: E({
    class: 'build_tool',
    title: 'The bundler or build tool failed',
    mechanical: [],
    guidance:
      'Read the tool message and repair the cause it names (a missing import, a bad configuration, a syntax error). If the message names no file, check the entry file and the configuration.',
    context: ['nearby_paths', 'package_manifest'],
    avoid: [...common],
    maxOps: 3,
    risk: 'medium',
  }),
  unknown: E({
    class: 'unknown',
    title: 'An error the engine does not recognise',
    mechanical: [],
    guidance:
      'Repair exactly what the message reports, in the file and line it names, and nothing else.',
    context: ['nearby_paths'],
    avoid: [...common],
    maxOps: 2,
    risk: 'medium',
  }),
};

/** the entries for the classes present, most frequent class first, deduplicated */
export function entriesFor(classes: readonly ErrorClass[]): StrategyEntry[] {
  const n = new Map<ErrorClass, number>();
  for (const c of classes) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([c]) => STRATEGY_CORPUS[c]);
}
