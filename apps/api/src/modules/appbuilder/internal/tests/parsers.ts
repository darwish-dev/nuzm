/** Structured test results (junit-like JSON) parsed from the tools' own output. Pure; never throws on malformed output (it reports `errored`). */
export interface TestCase {
  suite: string;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  durationMs: number;
  failure?: string;
}
export interface SuiteResult {
  suite: 'unit' | 'typecheck' | 'build' | 'e2e';
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  tests: number;
  failures: number;
  skipped: number;
  durationMs: number;
  cases: TestCase[];
  /** A stable signature of the failures (used by the debug loop to detect "the same failure again"). */
  signature: string | null;
}
const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** node:test `--test-reporter=junit` (JUnit XML). */
export function parseJunit(xml: string, suite: SuiteResult['suite'] = 'unit'): SuiteResult {
  const cases: TestCase[] = [];
  const caseRe = /<testcase\s+([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(xml))) {
    const attrs = m[1]!;
    const body = m[3] ?? '';
    const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1];
    const failure = /<failure\b([^>]*)>([\s\S]*?)<\/failure>|<failure\b([^>]*)\/>/.exec(body);
    const skipped = /<skipped\b/.test(body);
    cases.push({
      suite: decode(attr('classname') ?? 'tests'),
      name: decode(attr('name') ?? '?'),
      status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
      durationMs: Math.round(Number(attr('time') ?? 0) * 1000),
      ...(failure
        ? {
            failure: decode(
              (
                /message="([^"]*)"/.exec(failure[1] ?? failure[3] ?? '')?.[1] ??
                failure[2] ??
                'failed'
              ).trim(),
            ).slice(0, 500),
          }
        : {}),
    });
  }
  const failures = cases.filter((c) => c.status === 'failed');
  return {
    suite,
    status: cases.length === 0 ? 'errored' : failures.length ? 'failed' : 'passed',
    tests: cases.length,
    failures: failures.length,
    skipped: cases.filter((c) => c.status === 'skipped').length,
    durationMs: cases.reduce((n, c) => n + c.durationMs, 0),
    cases,
    signature: failures.length
      ? failureSignature(failures.map((f) => `${f.suite}::${f.name}::${f.failure ?? ''}`))
      : null,
  };
}

/** `tsc --noEmit` output: `path(line,col): error TS1234: message`. */
export function parseTsc(output: string, exitCode: number | null): SuiteResult {
  const errs = [...output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)];
  const cases: TestCase[] = errs.map((e) => ({
    suite: 'typecheck',
    name: `${e[1]}:${e[2]} ${e[4]}`,
    status: 'failed' as const,
    durationMs: 0,
    failure: e[5]!.slice(0, 300),
  }));
  const errored = exitCode !== 0 && errs.length === 0;
  return {
    suite: 'typecheck',
    status: errored ? 'errored' : errs.length ? 'failed' : 'passed',
    tests: Math.max(1, errs.length),
    failures: errs.length,
    skipped: 0,
    durationMs: 0,
    cases,
    signature: errs.length ? failureSignature(errs.map((e) => `${e[1]}::${e[4]}::${e[5]}`)) : null,
  };
}
export function parseBuild(
  output: string,
  exitCode: number | null,
  timedOut: boolean,
): SuiteResult {
  const failed = exitCode !== 0 || timedOut;
  const tail = output.trim().split('\n').slice(-5).join('\n').slice(0, 500);
  return {
    suite: 'build',
    status: timedOut ? 'errored' : failed ? 'failed' : 'passed',
    tests: 1,
    failures: failed ? 1 : 0,
    skipped: 0,
    durationMs: 0,
    cases: [
      {
        suite: 'build',
        name: 'build',
        status: failed ? 'failed' : 'passed',
        durationMs: 0,
        ...(failed ? { failure: timedOut ? 'the build timed out' : tail } : {}),
      },
    ],
    signature: failed ? failureSignature([tail]) : null,
  };
}
/** Order-independent hash-like signature of failure texts, with line/column numbers and timings stripped so "the same failure again" matches. */
export function failureSignature(parts: string[]): string {
  const norm = parts
    .map((p) =>
      p
        .replace(/\d+(\.\d+)?ms/g, '')
        .replace(/:\d+(:\d+)?/g, ':N')
        .replace(/\(\d+,\d+\)/g, '(N,N)')
        .replace(/\b[0-9a-f]{8,}\b/g, 'H')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .sort();
  let h = 5381;
  for (const c of norm.join('\n')) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return `${norm.length}:${h.toString(16)}`;
}

/** The group a failing case belongs to (the debug loop counts iterations per group): the file or suite of the failure. */
export function groupOf(c: TestCase): string {
  const m = /^(.+?\.(?:ts|js|json|sql)):?/.exec(c.name);
  return m ? m[1]! : c.suite;
}
