import ts from 'typescript';
import { builderTools } from '@nuzm/domain';

/**
 * The TypeScript compiler "twin" (P3-S03): the REAL TypeScript compiler run IN MEMORY over a project's files, producing the same diagnostics text as `tsc -p tsconfig.json --pretty false`.
 * It is what stands in for the isolated build runtime (P3-S02) until that is real, so the repair engine can be exercised against genuine compiler output instead of a script.
 *
 * What it is and is not (labels travel with every result):
 *  - it reads text and type-checks it; it executes NOTHING (no emit, no test, no script of the project, no package install), so it is safe to run on the host;
 *  - it is NOT the qualified runtime: `origin` is `MOCK`, results are SIMULATED evidence for the build step, never `LIVE-VERIFIED`;
 *  - only the files of the project and the standard library are visible: a bare package import resolves to nothing (that is the project's real behaviour without `node_modules`).
 * Never imported by the production module graph: tests and scripts only.
 */
export const TWIN_VERSION = `typescript ${ts.version}`;

export interface TwinResult {
  passed: boolean;
  /** the compiler's diagnostics, one per line (empty when it passes) */
  log: string;
  diagnostics: number;
}

const ROOT = '/p';
/** standard-library source files are parsed once per process (they never change and are by far the largest part of a compile) */
const LIB_CACHE = new Map<string, ts.SourceFile>();
const CODE = /\.(?:[cm]?[jt]sx?)$/;

export function typecheckProject(files: ReadonlyMap<string, string>): TwinResult {
  const cfgText = files.get('tsconfig.json');
  let compilerOptions: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    types: [],
  };
  let include: string[] = ['.'];
  if (cfgText !== undefined) {
    const parsed = ts.parseConfigFileTextToJson('tsconfig.json', cfgText);
    if (parsed.error) return fail(ts.formatDiagnostic(parsed.error, host(files)).trim());
    const o = ts.convertCompilerOptionsFromJson(
      (parsed.config as { compilerOptions?: unknown }).compilerOptions ?? {},
      ROOT,
    );
    if (o.errors.length) return fail(ts.formatDiagnostics(o.errors, host(files)).trim());
    compilerOptions = { ...o.options, noEmit: true };
    const inc = (parsed.config as { include?: unknown }).include;
    if (Array.isArray(inc)) include = inc.filter((x): x is string => typeof x === 'string');
  }
  const roots = [...files.keys()].filter(
    (p) =>
      CODE.test(p) &&
      include.some((i) => i === '.' || p === i || p.startsWith(`${i.replace(/\/$/, '')}/`)),
  );
  if (roots.length === 0)
    return fail("error TS18003: No inputs were found in config file 'tsconfig.json'.");
  const h = host(files, compilerOptions);
  const program = ts.createProgram({
    rootNames: roots.map((p) => `${ROOT}/${p}`),
    options: compilerOptions,
    host: h,
  });
  const diags = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  if (diags.length === 0) return { passed: true, log: '', diagnostics: 0 };
  const log = ts.formatDiagnostics(diags, h).trim();
  return { passed: false, log, diagnostics: diags.length };
}

const fail = (log: string): TwinResult => ({ passed: false, log, diagnostics: 1 });

function host(
  files: ReadonlyMap<string, string>,
  options: ts.CompilerOptions = {},
): ts.CompilerHost {
  const sys = ts.sys;
  const rel = (f: string) => (f.startsWith(`${ROOT}/`) ? f.slice(ROOT.length + 1) : null);
  const base = ts.createCompilerHost(options, true);
  return {
    ...base,
    getCurrentDirectory: () => ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => {
      const r = rel(f);
      return r !== null ? files.has(r) : sys.fileExists(f);
    },
    readFile: (f) => {
      const r = rel(f);
      return r !== null ? files.get(r) : sys.readFile(f);
    },
    directoryExists: (d) => {
      if (d === ROOT) return true;
      const r = rel(`${d}/`);
      return r !== null
        ? [...files.keys()].some((p) => p.startsWith(r))
        : (sys.directoryExists?.(d) ?? false);
    },
    getSourceFile: (f, lang, onError, shouldCreate) => {
      const r = rel(f);
      if (r !== null) {
        const t = files.get(r);
        return t === undefined ? undefined : ts.createSourceFile(f, t, lang);
      }
      const key = `${f}|${typeof lang === 'number' ? lang : lang.languageVersion}`;
      const hit = LIB_CACHE.get(key);
      if (hit) return hit;
      const sf = base.getSourceFile(f, lang, onError, shouldCreate);
      if (sf && /[\\/]typescript[\\/]lib[\\/]lib\.[\w.-]*\.d\.ts$/.test(f)) LIB_CACHE.set(key, sf);
      return sf;
    },
    writeFile: () => undefined,
  };
}

/**
 * A `BuildPort` over the twin. `typecheck` and `build` run the compiler over the version's files; `unit-tests` runs `tests` when given (a STATIC predicate: nothing is executed) and
 * otherwise reports that tests were not run. `origin` stays `MOCK`: this is not the runtime. The project's files come from `filesOf` (the version the request names).
 */
export class TypeScriptTwinBuildPort implements builderTools.BuildPort {
  readonly origin = 'MOCK' as const;
  readonly calls: builderTools.BuildRequest[] = [];
  constructor(
    private readonly filesOf: (
      req: builderTools.BuildRequest,
    ) => ReadonlyMap<string, string> | Promise<ReadonlyMap<string, string>>,
    private readonly tests:
      ((files: ReadonlyMap<string, string>) => { passed: boolean; log: string }) | null = null,
  ) {}
  async preflight(): Promise<builderTools.Preflight> {
    return { allowed: true, reasons: [], requiresApproval: false };
  }
  async build(req: builderTools.BuildRequest): Promise<builderTools.BuildResult> {
    this.calls.push(req);
    const files = await this.filesOf(req);
    const t0 = files.size; // a stable, clock-free "duration" input: the twin's work is proportional to the project size
    if (req.profile === 'unit-tests') {
      if (!this.tests)
        return {
          status: 'completed',
          logs: `[TWIN ${TWIN_VERSION}] tests are not executed by the twin\n`,
          artifacts: [],
          durationMs: 1,
        };
      const r = this.tests(files);
      return {
        status: r.passed ? 'completed' : 'failed',
        logs: r.passed ? '[TWIN] static test predicate passed\n' : r.log,
        artifacts: [],
        durationMs: 1,
      };
    }
    const r = typecheckProject(files);
    return {
      status: r.passed ? 'completed' : 'failed',
      logs: r.passed ? `[TWIN ${TWIN_VERSION}] ${req.profile}: no errors\n` : `${r.log}\n`,
      artifacts: [],
      durationMs: Math.max(1, t0),
    };
  }
}
