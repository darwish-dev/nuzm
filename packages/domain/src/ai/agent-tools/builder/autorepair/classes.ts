/**
 * Error classes of the automatic repair engine (P3-S03). A build or test failure is reduced to a small closed set of CLASSES so that (a) a repair strategy can be chosen per class,
 * (b) the success rate, rounds and tokens can be measured per class, and (c) a table of "what failed and what fixed it" can be shown without quoting a log. The class is derived
 * from the tool, the tool's own error code and the message; it never depends on file content. Pure: no I/O, no clock.
 */
export const ERROR_CLASSES = [
  'type_mismatch',
  'missing_property',
  'null_safety',
  'call_signature',
  'undefined_name',
  'implicit_any',
  'duplicate_declaration',
  'missing_module',
  'missing_package',
  'missing_export',
  'unused_symbol',
  'syntax_error',
  'config_error',
  'test_assertion',
  'test_runtime_error',
  'lint',
  'dependency_resolution',
  'native_compile',
  'build_tool',
  'unknown',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

export type ToolFamily = 'typescript' | 'bundler' | 'test' | 'lint' | 'dart' | 'gradle' | 'other';

const TS_CLASS: Record<string, ErrorClass> = {};
const put = (c: ErrorClass, codes: number[]) => {
  for (const n of codes) TS_CLASS[`TS${n}`] = c;
};
put(
  'type_mismatch',
  [
    2322, 2345, 2352, 2362, 2363, 2365, 2367, 2403, 2416, 2417, 2430, 2559, 2678, 2739, 2740, 2741,
    2769, 2820, 2344, 2538, 2536,
  ],
);
put('missing_property', [2339, 2551, 2353, 2561, 2576, 2693, 2724]);
put('null_safety', [2531, 2532, 2533, 2722, 2790, 18046, 18047, 18048, 18049, 2454, 2564, 2565]);
put('call_signature', [2554, 2555, 2556, 2557, 2349, 2348, 2351, 2350, 2375, 2379]);
put('undefined_name', [2304, 2552, 2580, 2581, 2582, 2583, 2584, 2686, 2663, 18004, 2503, 2693]);
put('implicit_any', [7005, 7006, 7008, 7010, 7011, 7015, 7016, 7019, 7022, 7023, 7031, 7034, 7053]);
put('duplicate_declaration', [2300, 2393, 2451, 2440, 2323, 2528, 2395, 2813, 2814]);
put('missing_export', [2305, 2459, 2460, 2614, 2724, 2595, 1192, 1259]);
put('unused_symbol', [6133, 6192, 6196, 6198, 6199, 6205, 6138]);
put(
  'config_error',
  [
    5009, 5023, 5024, 5025, 5042, 5052, 5053, 5054, 5055, 5056, 5058, 5083, 5090, 6046, 6053, 6054,
    18003, 18002, 18028, 17004, 6504, 2688,
  ],
);
// 1xxx = syntax and parse errors
for (let n = 1002; n <= 1500; n++) if (!TS_CLASS[`TS${n}`]) TS_CLASS[`TS${n}`] = 'syntax_error';

const unquote = (s: string | undefined): string | null => {
  if (!s) return null;
  const t = s.trim().replace(/^['"`‘“]|['"`’”]$/g, '');
  return t.length > 0 && t.length <= 120 ? t : null;
};

/** `Cannot find name 'foo'` → foo; `Module './x' has no exported member 'Y'` → Y; `Cannot find module './z'` → ./z. The subject is what a strategy acts on. */
export function subjectOf(message: string): string | null {
  const patterns: RegExp[] = [
    /Cannot find name\s+['"‘]([^'"’]+)['"’]/i,
    /has no exported member\s+(?:named\s+)?['"‘]([^'"’]+)['"’]/i,
    /declares\s+['"‘]([^'"’]+)['"’]\s+locally/i,
    /Cannot find module\s+['"‘]([^'"’]+)['"’]/i,
    /Could not resolve\s+['"‘]([^'"’]+)['"’]/i,
    /Can't resolve\s+['"‘]([^'"’]+)['"’]/i,
    /Property\s+['"‘]([^'"’]+)['"’]\s+does not exist/i,
    /['"‘]([^'"’]+)['"’]\s+is declared but its value is never read/i,
    /['"‘]([^'"’]+)['"’]\s+is defined but never used/i,
    /Undefined name\s+['"‘]([^'"’]+)['"’]/i,
    /Unresolved reference:?\s+([A-Za-z_][\w.]*)/i,
    /cannot find symbol[\s\S]*?symbol:\s*(?:class|variable|method)\s+([A-Za-z_][\w.]*)/i,
    /Target of URI doesn't exist:\s+['"‘]([^'"’]+)['"’]/i,
    /Unused import:\s+['"‘]([^'"’]+)['"’]/i,
    /([A-Za-z_$][\w$.]*) is not defined/,
    /([A-Za-z_$][\w$.]*) is not a function/,
  ];
  for (const re of patterns) {
    const m = re.exec(message);
    if (m) return unquote(m[1]);
  }
  return null;
}

const isRelative = (spec: string) =>
  spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('~/');

export interface ClassifyInput {
  family: ToolFamily;
  code: string | null;
  message: string;
}
export interface Classified {
  class: ErrorClass;
  subject: string | null;
}

/** The class of one diagnostic. Unknown tool output is `unknown` (never guessed): such a failure is still repairable by a model, but it is reported as its own row in the metrics. */
export function classify(i: ClassifyInput): Classified {
  const msg = i.message;
  const subject = subjectOf(msg);
  const code = i.code ?? '';
  const done = (c: ErrorClass): Classified => ({ class: c, subject });
  if (i.family === 'typescript') {
    if (code === 'TS2307' || code === 'TS2792' || code === 'TS7016')
      return done(subject && !isRelative(subject) ? 'missing_package' : 'missing_module');
    const c = TS_CLASS[code];
    if (c) return done(c);
    if (/is not assignable|not assignable to/i.test(msg)) return done('type_mismatch');
    if (/does not exist on type/i.test(msg)) return done('missing_property');
    if (/Cannot find name/i.test(msg)) return done('undefined_name');
    if (/Cannot find module/i.test(msg))
      return done(subject && !isRelative(subject) ? 'missing_package' : 'missing_module');
    return done('unknown');
  }
  if (i.family === 'bundler') {
    if (
      /(?:Could not resolve|Can't resolve|failed to resolve import|Module not found|Cannot find module)/i.test(
        msg,
      )
    )
      return done(subject && !isRelative(subject) ? 'missing_package' : 'missing_module');
    if (
      /(?:Unexpected token|SyntaxError|Parsing error|Expected .* but found|Unterminated)/i.test(msg)
    )
      return done('syntax_error');
    if (/(?:is not exported by|has no exported member|No matching export)/i.test(msg))
      return done('missing_export');
    if (/Type error:/i.test(msg)) {
      const t = classify({
        family: 'typescript',
        code: null,
        message: msg.replace(/^.*?Type error:\s*/i, ''),
      });
      return t.class === 'unknown' ? done('type_mismatch') : t;
    }
    return done('build_tool');
  }
  if (i.family === 'test') {
    if (
      /(?:AssertionError|expected .* (?:to|received)|Expected:|toBe\(|toEqual\(|to equal|expect\()/i.test(
        msg,
      )
    )
      return done('test_assertion');
    if (
      /(?:TypeError|ReferenceError|RangeError|is not a function|is not defined|Cannot read propert|undefined is not)/i.test(
        msg,
      )
    )
      return done('test_runtime_error');
    return done('test_assertion');
  }
  if (i.family === 'lint') return done('lint');
  if (i.family === 'dart') {
    if (/uri_does_not_exist|Target of URI doesn't exist|URI doesn't exist/i.test(`${code} ${msg}`))
      return done('missing_module');
    if (
      /undefined_identifier|undefined_function|undefined_class|undefined_method|Undefined (?:name|class|function|method)/i.test(
        `${code} ${msg}`,
      )
    )
      return done('undefined_name');
    if (
      /undefined_getter|undefined_setter|The getter|The setter|isn't defined for the (?:type|class)/i.test(
        `${code} ${msg}`,
      )
    )
      return done('missing_property');
    if (
      /argument_type_not_assignable|invalid_assignment|return_of_invalid_type|can't be assigned|isn't a subtype/i.test(
        `${code} ${msg}`,
      )
    )
      return done('type_mismatch');
    if (
      /unused_import|unused_local_variable|unused_element|unused_field|unused_shown_name|Unused import/i.test(
        `${code} ${msg}`,
      )
    )
      return done('unused_symbol');
    if (
      /not_enough_positional_arguments|extra_positional_arguments|missing_required_argument|too (?:many|few) positional|required named parameter/i.test(
        `${code} ${msg}`,
      )
    )
      return done('call_signature');
    if (
      /(?:unchecked_use_of_nullable|receiver_of_type_never|can't be accessed unconditionally|nullable)/i.test(
        `${code} ${msg}`,
      )
    )
      return done('null_safety');
    if (
      /(?:expected_token|missing_identifier|unexpected_token|Expected to find)/i.test(
        `${code} ${msg}`,
      )
    )
      return done('syntax_error');
    if (/(?:pubspec|version solving failed|Because .* depends on)/i.test(msg))
      return done('dependency_resolution');
    return done('unknown');
  }
  if (i.family === 'gradle') {
    if (/Could not (?:resolve|find|download)|Failed to resolve|dependency/i.test(msg))
      return done('dependency_resolution');
    if (/(?:Unresolved reference|cannot find symbol|package .* does not exist)/i.test(msg))
      return done('undefined_name');
    if (/(?:Type mismatch|incompatible types)/i.test(msg)) return done('type_mismatch');
    if (/(?:Duplicate class|Redeclaration)/i.test(msg)) return done('duplicate_declaration');
    if (/(?:Expecting|Unexpected tokens|expected;|illegal start)/i.test(msg))
      return done('syntax_error');
    if (/(?:compileSdk|minSdk|AndroidManifest|namespace|Manifest merger)/i.test(msg))
      return done('config_error');
    return done('native_compile');
  }
  return done('unknown');
}

/** Classes whose fix is a mechanical edit a deterministic fixer may try first. The rest always go to a model (or to a person). */
export const MECHANICAL_CLASSES: readonly ErrorClass[] = [
  'missing_module',
  'undefined_name',
  'missing_export',
  'unused_symbol',
  'config_error',
  'syntax_error',
];
