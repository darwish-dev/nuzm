import { MAX_ERRORS, type BuildErrorClass, type ParsedBuildError } from './types';
import { cap, clean, dedupe, editableSource, excerptOf, projectPath, redact } from './common';

/**
 * Dart / Flutter output parser. Three formats are understood:
 *  1. `flutter analyze` / `dart analyze`:        `  error • Message • lib/main.dart:12:20 • rule_name`
 *  2. the front-end compiler (flutter build/test): `lib/main.dart:12:20: Error: Message.`
 *  3. `flutter test` reporter:                    `00:03 +1 -1: some test name [E]` followed by the failure text, and the `Some tests failed.` footer
 * Format facts come from the public Dart/Flutter tool output; the fixtures in `fixtures/` are the formats this parser is tested against.
 */
const ANALYZE_BULLET =
  /^\s*(error|warning|info)\s+•\s+(.+?)\s+•\s+(\S+?):(\d+):(\d+)\s+•\s+([a-z_0-9]+)\s*$/;
const ANALYZE_DASH =
  /^\s*(error|warning|info)\s+-\s+(\S+?):(\d+):(\d+)\s+-\s+(.+?)\s+-\s+([a-z_0-9]+)\s*$/;
const COMPILER = /^\s*(?:file:\/\/)?(\S+?\.dart):(\d+):(\d+):\s*(Error|Warning):\s*(.+)$/;
const TEST_FAIL = /^\d\d:\d\d\s+\+\d+(?:\s+~\d+)?\s+-(\d+):\s+(.*?)\s+\[E\]\s*$/;
const TEST_LOAD_FAIL = /^\d\d:\d\d\s+\+\d+(?:\s+~\d+)?\s+-\d+:\s+loading\s+(\S+)\s+\[E\]\s*$/;

/** analyzer rule / compiler message -> class. The match order matters: the most specific first. */
function classify(code: string | undefined, message: string): BuildErrorClass {
  const m = message.toLowerCase();
  const c = (code ?? '').toLowerCase();
  if (
    c === 'uri_does_not_exist' ||
    /target of uri doesn't exist|could not resolve the package|can't find|couldn't find.*library|^not found: /.test(
      m,
    )
  )
    return 'pub_missing_package' as BuildErrorClass; // refined by the caller to dart_missing_import vs pub_missing_package
  if (
    c === 'undefined_identifier' ||
    c === 'undefined_function' ||
    c === 'undefined_method' ||
    c === 'undefined_getter' ||
    c === 'undefined_class' ||
    c === 'undefined_named_parameter' ||
    c === 'undefined_prefixed_name' ||
    c === 'creation_with_non_type' ||
    c === 'undefined_setter' ||
    /isn't defined for the|undefined name|isn't a (?:function|type|class)|method '.*' isn't defined|getter '.*' isn't defined/.test(
      m,
    )
  )
    return 'dart_undefined_name';
  if (
    /argument_type_not_assignable|invalid_assignment|return_of_invalid_type|invalid_override|cast_to_non_type|non_bool_condition|type_test_with_undefined_name|wrong_number_of_type_arguments|list_element_type_not_assignable|map_value_type_not_assignable|body_might_complete_normally/.test(
      c,
    ) ||
    /can't be assigned to|isn't a subtype of|can't be returned from|is not a subtype/.test(m)
  )
    return 'dart_type_error';
  if (
    /missing_required_argument|not_enough_positional_arguments|extra_positional_arguments|missing_default_value_for_parameter/.test(
      c,
    ) ||
    /required named parameter|too (?:few|many) positional arguments|not enough positional arguments/.test(
      m,
    )
  )
    return 'dart_missing_argument';
  if (
    /null_check|unchecked_use_of_nullable|receiver_of_type_never|invalid_null_aware|non_nullable_/.test(
      c,
    ) ||
    /can't be accessed because it .* be null|nullable|null safety|can't be 'null'|must be assigned before it can be used|late/.test(
      m,
    )
  )
    return 'dart_null_safety';
  if (
    /expected_token|missing_identifier|expected_executable|unterminated|missing_const_final_var_or_type|extra_text_after_end_of_file|unexpected_token|missing_function_body/.test(
      c,
    ) ||
    /expected (?:a|an|to find)|unexpected|unterminated|missing|can't find ['"].*['"] to match/.test(
      m,
    )
  )
    return 'dart_syntax_error';
  return 'dart_other_error';
}

function mapUriError(message: string, ownPackage?: string): BuildErrorClass {
  // `package:foo/foo.dart` for a package that is not a dependency -> add the dependency; a relative/own-package path that does not exist -> fix the import
  const pkg = /package:([a-z0-9_]+)\//.exec(message);
  if (pkg && pkg[1] !== undefined && pkg[1] !== ownPackage) return 'pub_missing_package';
  return 'dart_missing_import';
}

function build(
  roots: readonly string[],
  severity: 'error' | 'warning',
  rawFile: string | undefined,
  line: number | undefined,
  column: number | undefined,
  message: string,
  code: string | undefined,
  excerpt: string,
  inTest: boolean,
  ownPackage?: string,
): ParsedBuildError {
  let cls = classify(code, message);
  if (cls === ('pub_missing_package' as BuildErrorClass)) cls = mapUriError(message, ownPackage);
  const file = rawFile ? projectPath(rawFile, roots) : undefined;
  const generated = file?.startsWith('lib/generated/') === true;
  const targets = editableSource(file);
  const fix = cls === 'pub_missing_package' ? 'edit_pubspec' : 'edit_source';
  const hints: Record<string, string> = {
    dart_type_error:
      'Change the expression or the declared type so the types agree; do not add casts that hide the error.',
    dart_undefined_name:
      'The name is not defined or not imported: define it, fix the spelling, or import the library that declares it.',
    dart_missing_import:
      'The imported file does not exist: fix the path, create the file, or remove the import.',
    pub_missing_package:
      'The code imports a package that pubspec.yaml does not list. Add it only if it is on the Nuzm pub allow-list (exact allow-listed constraint); otherwise remove the import.',
    dart_syntax_error:
      'Fix the syntax at the reported position (missing bracket, semicolon or token).',
    dart_missing_argument: 'Supply the required argument(s) or adjust the call to the declaration.',
    dart_null_safety:
      'Handle null explicitly (null check, `??`, or make the type nullable) instead of using `!` everywhere.',
    dart_other_error: 'Read the message and fix the reported line.',
  };
  return {
    tool: inTest ? 'flutter-test' : 'dart',
    errorClass: cls,
    severity,
    message: cap(redact(message).replace(/\s+/g, ' ').trim(), 500),
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(code ? { code } : {}),
    fix,
    targetFiles: cls === 'pub_missing_package' ? ['pubspec.yaml'] : generated ? [] : targets,
    hint:
      (hints[cls] ?? hints.dart_other_error!) +
      (generated
        ? ' The file is generated from the mobile spec: change the spec, never the generated file.'
        : ''),
    excerpt,
  };
}

export function parseDart(
  raw: string,
  roots: readonly string[] = [],
  ownPackage?: string,
): ParsedBuildError[] {
  const lines = clean(raw).split('\n');
  const out: ParsedBuildError[] = [];
  let failedTests = 0;
  for (let i = 0; i < lines.length && out.length < MAX_ERRORS; i++) {
    const l = lines[i]!;
    let m = ANALYZE_BULLET.exec(l);
    if (m && m[1] !== 'info') {
      out.push(
        build(
          roots,
          m[1] === 'warning' ? 'warning' : 'error',
          m[3],
          Number(m[4]),
          Number(m[5]),
          m[2]!,
          m[6],
          excerptOf(lines, i, 1),
          (m[3] ?? '').startsWith('test/'),
          ownPackage,
        ),
      );
      continue;
    }
    m = ANALYZE_DASH.exec(l);
    if (m && m[1] !== 'info') {
      out.push(
        build(
          roots,
          m[1] === 'warning' ? 'warning' : 'error',
          m[2],
          Number(m[3]),
          Number(m[4]),
          m[5]!,
          m[6],
          excerptOf(lines, i, 1),
          (m[2] ?? '').startsWith('test/'),
          ownPackage,
        ),
      );
      continue;
    }
    m = COMPILER.exec(l);
    if (m) {
      const msg = m[5]!;
      // the compiler prints the offending source and a caret on the following lines; include them in the excerpt
      out.push(
        build(
          roots,
          m[4] === 'Warning' ? 'warning' : 'error',
          m[1],
          Number(m[2]),
          Number(m[3]),
          msg,
          undefined,
          excerptOf(lines, i, 3),
          (m[1] ?? '').startsWith('test/'),
          ownPackage,
        ),
      );
      continue;
    }
    const lf = TEST_LOAD_FAIL.exec(l);
    if (lf) {
      // test file failed to LOAD: a compile error in a test (the compiler lines that follow are parsed on their own)
      out.push({
        tool: 'flutter-test',
        errorClass: 'test_compile_error',
        severity: 'error',
        message: `test file ${lf[1]} failed to load`,
        ...(projectPath(lf[1]!, roots) ? { file: projectPath(lf[1]!, roots)! } : {}),
        fix: 'edit_source',
        targetFiles: editableSource(projectPath(lf[1]!, roots)),
        hint: 'The test file does not compile; fix the compile errors reported with it.',
        excerpt: excerptOf(lines, i, 1),
      });
      continue;
    }
    const tf = TEST_FAIL.exec(l);
    if (tf) {
      failedTests++;
      // the failure text (Expected/Actual or the exception) sits in the next lines until the next reporter line
      const body: string[] = [];
      for (
        let j = i + 1;
        j < lines.length && body.length < 8 && !/^\d\d:\d\d\s+\+/.test(lines[j]!);
        j++
      ) {
        if (lines[j]!.trim()) body.push(lines[j]!.trim());
      }
      const at = body.map((b) => /(\S+_test\.dart)[: ](\d+):(\d+)/.exec(b)).find(Boolean);
      const file = at ? projectPath(at[1]!, roots) : undefined;
      out.push({
        tool: 'flutter-test',
        errorClass: 'test_failure',
        severity: 'error',
        message: cap(redact(`test failed: ${tf[2]}${body[0] ? ' — ' + body[0] : ''}`), 500),
        ...(file ? { file } : {}),
        ...(at ? { line: Number(at[2]), column: Number(at[3]) } : {}),
        fix: 'edit_source',
        targetFiles: [],
        hint: 'Decide whether the test or the code is wrong. Fix the code unless the test contradicts the approved spec; never delete or weaken a test just to pass.',
        excerpt: cap([redact(l), ...body.slice(0, 5).map(redact)].join('\n'), 800),
      });
    }
  }
  void failedTests;
  return dedupe(out);
}
