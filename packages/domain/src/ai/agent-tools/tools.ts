import { validateSchema, type Schema } from '../../schema';
import { AGENT_TOOL_LIMITS as L, type ToolErrorCode } from './limits';
import { compileGlob, inDir, normalizeToolDir, normalizeToolPath } from './paths';
import type { ReadOnlyWorkspace } from './workspace';

/**
 * The four read-only tools of stage 1 (D-46, SCR-K-10 §3): `list_files`, `read_file`, `search_code`, `inspect_project`. Pure functions of (arguments, workspace): no filesystem, no process,
 * no network, no clock, no randomness. A tool never throws: it returns a result or a structured refusal whose message is fixed in code (it never quotes the model's arguments, a path or a
 * file). Arguments are validated against the tool's own schema here as well as by the gateway (defence in depth).
 */
export const READ_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_code',
  'inspect_project',
] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];

export interface ReadToolSpec {
  name: ReadToolName;
  description: string;
  inputSchema: Schema & { type: 'object' };
}
const str = (max: number, min = 1): Schema => ({ type: 'string', minLength: min, maxLength: max });

export const READ_TOOL_SPECS: readonly ReadToolSpec[] = [
  {
    name: 'list_files',
    description:
      'List the files of the project (path, size in bytes, who wrote it, whether its content may be read), optionally inside one directory or matching a glob. Sorted by path. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        dir: str(L.pathMaxChars, 0),
        glob: str(L.globMaxChars),
        limit: { type: 'integer', minimum: 1, maximum: L.maxListLimit },
      },
    },
  },
  {
    name: 'read_file',
    description: `Read a text file of the project, optionally a range of lines (1-based, inclusive). At most ${L.maxReadChars} characters per call: when the file is longer the answer says where to continue. Read-only.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: str(L.pathMaxChars),
        startLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
        endLine: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      },
    },
  },
  {
    name: 'search_code',
    description:
      'Search the text files of the project for a literal string (not a pattern). Returns path, line number and the line (shortened). Case-insensitive unless caseSensitive is true. Read-only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: str(L.queryMaxChars),
        pathGlob: str(L.globMaxChars),
        limit: { type: 'integer', minimum: 1, maximum: L.maxSearchLimit },
        caseSensitive: { type: 'boolean' },
      },
    },
  },
  {
    name: 'inspect_project',
    description:
      'Summarise the project: file counts by extension, top-level entries, manifests and entry points that exist, the frameworks its dependencies imply, and the NAMES of its scripts (scripts are never run). Read-only.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

export type ReadToolResult =
  | { ok: true; output: Record<string, unknown>; truncated: boolean; notes: string[] }
  | { ok: false; code: ToolErrorCode; message: string };

const MESSAGES: Record<ToolErrorCode, string> = {
  invalid_arguments: 'the arguments do not match the tool schema',
  invalid_path: 'the path is not a valid project-relative path',
  not_found: 'no such file in the project',
  not_permitted: 'this file cannot be read by the agent',
  too_large: 'the result is too large',
  unknown_tool: 'this tool is not available',
  internal_error: 'the tool failed',
};
const fail = (code: ToolErrorCode, why?: string): ReadToolResult => ({
  ok: false,
  code,
  message: why ? `${MESSAGES[code]} (${why})` : MESSAGES[code],
});
const ok = (
  output: Record<string, unknown>,
  truncated = false,
  notes: string[] = [],
): ReadToolResult => ({ ok: true, output, truncated, notes });

const specOf = (name: string) => READ_TOOL_SPECS.find((s) => s.name === name);

/** Runs one read-only tool. Total: any failure is a refusal result, never an exception. */
export function executeReadTool(
  name: string,
  args: unknown,
  ws: ReadOnlyWorkspace,
): ReadToolResult {
  const spec = specOf(name);
  if (!spec) return fail('unknown_tool');
  try {
    if (validateSchema(spec.inputSchema, args ?? {}).length > 0) return fail('invalid_arguments');
    const a = (args ?? {}) as Record<string, unknown>;
    switch (spec.name) {
      case 'list_files':
        return listFiles(a, ws);
      case 'read_file':
        return readFile(a, ws);
      case 'search_code':
        return searchCode(a, ws);
      case 'inspect_project':
        return inspectProject(ws);
    }
  } catch {
    return fail('internal_error');
  }
}

function listFiles(a: Record<string, unknown>, ws: ReadOnlyWorkspace): ReadToolResult {
  const dir = normalizeToolDir(a.dir);
  if (!dir.ok) return fail('invalid_path');
  const re = a.glob === undefined ? null : compileGlob(a.glob);
  if (a.glob !== undefined && !re) return fail('invalid_arguments', 'glob');
  const limit = typeof a.limit === 'number' ? a.limit : L.defaultListLimit;
  const all = ws.entries().filter((e) => inDir(e.path, dir.dir) && (!re || re.test(e.path)));
  const files = all
    .slice(0, limit)
    .map((e) => ({ path: e.path, bytes: e.bytes, origin: e.origin, readable: ws.readable(e) }));
  return ok(
    { files, total: all.length },
    all.length > files.length,
    all.length > files.length
      ? [`${all.length - files.length} more files; narrow with dir or glob`]
      : [],
  );
}

function readFile(a: Record<string, unknown>, ws: ReadOnlyWorkspace): ReadToolResult {
  const p = normalizeToolPath(a.path);
  if (!p.ok) return fail('invalid_path');
  const acc = ws.access(p.path);
  if (!acc.ok) {
    if (acc.code === 'not_found') return fail('not_found');
    // a refusal says why in a fixed word, never anything of the file
    return fail(
      'not_permitted',
      acc.code === 'ai_processing_not_allowed'
        ? 'the template does not allow AI processing of its source'
        : 'sensitive file',
    );
  }
  const lines = acc.text.split('\n');
  const total = lines.length;
  const start = typeof a.startLine === 'number' ? a.startLine : 1;
  const end = typeof a.endLine === 'number' ? Math.min(a.endLine, total) : total;
  if (start > total) return fail('invalid_arguments', 'startLine is past the end of the file');
  if (end < start) return fail('invalid_arguments', 'endLine is before startLine');
  let text = '';
  let last = start - 1;
  for (let i = start - 1; i < end; i++) {
    const next = (text === '' && i === start - 1 ? '' : '\n') + lines[i]!;
    if (text.length + next.length > L.maxReadChars) break;
    text += next;
    last = i + 1;
  }
  let truncated = last < end;
  if (last < start && start <= total) {
    // one line longer than the ceiling: cut it, and say so
    text = lines[start - 1]!.slice(0, L.maxReadChars);
    last = start;
    truncated = true;
  }
  return ok(
    {
      path: p.path,
      startLine: start,
      endLine: last,
      totalLines: total,
      text,
      ...(truncated && last < total ? { nextStartLine: last + 1 } : {}),
    },
    truncated,
    truncated ? [`the range was cut at ${L.maxReadChars} characters`] : [],
  );
}

function searchCode(a: Record<string, unknown>, ws: ReadOnlyWorkspace): ReadToolResult {
  const query = a.query as string;
  if (query.trim() === '') return fail('invalid_arguments', 'query');
  const re = a.pathGlob === undefined ? null : compileGlob(a.pathGlob);
  if (a.pathGlob !== undefined && !re) return fail('invalid_arguments', 'pathGlob');
  const limit = typeof a.limit === 'number' ? a.limit : L.defaultSearchLimit;
  const sensitive = a.caseSensitive === true;
  const needle = sensitive ? query : query.toLowerCase();
  const hits: { path: string; line: number; text: string }[] = [];
  let files = 0;
  let scanned = 0;
  let withheld = 0;
  let cut = false;
  for (const e of ws.entries()) {
    if (re && !re.test(e.path)) continue;
    if (!ws.readable(e)) {
      withheld++;
      continue;
    }
    if (files >= L.searchMaxFiles || scanned >= L.searchMaxBytes) {
      cut = true;
      break;
    }
    const acc = ws.access(e.path);
    if (!acc.ok || e.bytes > L.searchMaxFileBytes) continue;
    files++;
    scanned += e.bytes;
    const lines = acc.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hay = sensitive ? lines[i]! : lines[i]!.toLowerCase();
      if (hay.includes(needle)) {
        hits.push({ path: e.path, line: i + 1, text: lines[i]!.trim().slice(0, L.snippetChars) });
        if (hits.length >= limit) break;
      }
    }
    if (hits.length >= limit) {
      cut = true;
      break;
    }
  }
  const notes = [
    ...(withheld
      ? [
          `${withheld} template files were not searched: the template does not allow AI processing of its source`,
        ]
      : []),
    ...(cut ? ['the search stopped at its limit; narrow it with pathGlob'] : []),
  ];
  return ok({ hits, filesSearched: files, filesWithheld: withheld }, cut, notes);
}

const MANIFESTS = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'vite.config.ts',
  'vite.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
  'pubspec.yaml',
  'Dockerfile',
  'README.md',
  'LICENSE',
];
const ENTRY_POINTS = [
  'src/main.ts',
  'src/index.ts',
  'src/index.tsx',
  'src/app/page.tsx',
  'app/page.tsx',
  'pages/index.tsx',
  'pages/index.js',
  'index.html',
  'src/main.tsx',
  'lib/main.dart',
  'server.js',
  'src/server.ts',
];
const FRAMEWORKS: [string, string][] = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['svelte', 'Svelte'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['@angular/core', 'Angular'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS'],
  ['vite', 'Vite'],
  ['tailwindcss', 'Tailwind CSS'],
  ['astro', 'Astro'],
  ['remix', 'Remix'],
  ['@remix-run/react', 'Remix'],
];

function inspectProject(ws: ReadOnlyWorkspace): ReadToolResult {
  const entries = ws.entries();
  const byExt = new Map<string, { files: number; bytes: number }>();
  const top = new Set<string>();
  let bytes = 0;
  for (const e of entries) {
    bytes += e.bytes;
    const slash = e.path.indexOf('/');
    top.add(slash === -1 ? e.path : `${e.path.slice(0, slash)}/`);
    const dot = e.path.lastIndexOf('.');
    const ext = dot > e.path.lastIndexOf('/') ? e.path.slice(dot).toLowerCase() : '(none)';
    const x = byExt.get(ext) ?? { files: 0, bytes: 0 };
    x.files++;
    x.bytes += e.bytes;
    byExt.set(ext, x);
  }
  const paths = new Set(entries.map((e) => e.path));
  const notes: string[] = [];
  let pkg: Record<string, unknown> | undefined;
  let frameworks: string[] = [];
  if (paths.has('package.json')) {
    const acc = ws.access('package.json');
    if (!acc.ok)
      notes.push(
        'package.json exists but its content may not be read by the agent (the template does not allow AI processing of its source)',
      );
    else {
      try {
        const j = JSON.parse(acc.text) as Record<string, unknown>;
        const deps = (o: unknown) =>
          Object.entries((o && typeof o === 'object' ? o : {}) as Record<string, unknown>)
            .slice(0, L.inspectMaxDeps)
            .map(([name, version]) => ({
              name: name.slice(0, 80),
              version: String(version).slice(0, 40),
            }));
        const dependencies = deps(j.dependencies);
        const devDependencies = deps(j.devDependencies);
        const names = new Set([
          ...Object.keys((j.dependencies as object) ?? {}),
          ...Object.keys((j.devDependencies as object) ?? {}),
        ]);
        frameworks = [
          ...new Set(FRAMEWORKS.filter(([n]) => names.has(n)).map(([, label]) => label)),
        ];
        pkg = {
          name: typeof j.name === 'string' ? j.name.slice(0, 100) : null,
          version: typeof j.version === 'string' ? j.version.slice(0, 40) : null,
          dependencies,
          devDependencies,
          scriptNames: Object.keys((j.scripts as object) ?? {})
            .slice(0, L.inspectMaxScripts)
            .map((s) => s.slice(0, 60)),
        };
      } catch {
        notes.push('package.json is not valid JSON');
      }
    }
  }
  return ok(
    {
      fileCount: entries.length,
      totalBytes: bytes,
      byExtension: [...byExt.entries()]
        .sort((a, b) => b[1].files - a[1].files || (a[0] < b[0] ? -1 : 1))
        .slice(0, L.inspectMaxExtensions)
        .map(([extension, v]) => ({ extension, ...v })),
      topLevel: [...top].sort().slice(0, L.inspectMaxTopLevel),
      manifests: MANIFESTS.filter((m) => paths.has(m)),
      entryPoints: ENTRY_POINTS.filter((m) => paths.has(m)),
      frameworks,
      ...(pkg ? { package: pkg } : {}),
    },
    false,
    notes,
  );
}

/** The text a model receives for a result: compact JSON, bounded. A result that does not fit is refused as `too_large` (the tools bound themselves; this is the last guard). */
export function renderToolResult(
  r: ReadToolResult,
  maxBytes: number = L.maxResultBytesPerCall,
): { text: string; isError: boolean; code?: ToolErrorCode } {
  if (!r.ok)
    return {
      text: JSON.stringify({ error: r.code, message: r.message }),
      isError: true,
      code: r.code,
    };
  const text = JSON.stringify({
    ...r.output,
    ...(r.truncated ? { truncated: true } : {}),
    ...(r.notes.length ? { notes: r.notes } : {}),
  });
  if (Buffer.byteLength(text, 'utf8') > maxBytes)
    return {
      text: JSON.stringify({ error: 'too_large', message: MESSAGES.too_large }),
      isError: true,
      code: 'too_large',
    };
  return { text, isError: false };
}
