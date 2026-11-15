/**
 * Spec drift check (bootstrap B5): every HTTP route declared in apps/api controllers must exist
 * in spec/openapi/openapi.yaml with the same method. Regex-based on Nest decorators; limitation:
 * dynamic route strings are not understood and are reported as errors.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const specPath = join(root, 'spec/openapi/openapi.yaml');
const srcDir = join(root, 'apps/api/src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory()
      ? walk(p)
      : p.endsWith('.ts') && !p.endsWith('.spec.ts')
        ? [p]
        : [];
  });
}

const norm = (p: string) =>
  ('/' + p.split('/').filter(Boolean).join('/')).replace(/:([A-Za-z0-9_]+)/g, '{$1}');

const spec = parse(readFileSync(specPath, 'utf8')) as {
  paths?: Record<string, Record<string, unknown>>;
};
const declared = new Set<string>();
for (const [path, ops] of Object.entries(spec.paths ?? {})) {
  for (const method of Object.keys(ops)) declared.add(`${method.toUpperCase()} ${norm(path)}`);
}

const problems: string[] = [];
const found: string[] = [];
for (const file of walk(srcDir)) {
  const src = readFileSync(file, 'utf8');
  const ctrl = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/.exec(src);
  if (!ctrl) {
    if (/@Controller\(/.test(src)) problems.push(`${file}: non-literal @Controller argument`);
    continue;
  }
  const prefix = ctrl[1] ?? ctrl[2] ?? '';
  for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)/g)) {
    const route = m[2] ?? m[3] ?? '';
    const key = `${m[1]!.toUpperCase()} ${norm(`${prefix}/${route}`)}`;
    found.push(key);
    if (!declared.has(key))
      problems.push(`${file}: ${key} is implemented but missing from openapi.yaml`);
  }
  if (/@(Get|Post|Put|Patch|Delete)\(\s*[^'")\s]/.test(src)) {
    problems.push(`${file}: non-literal route decorator argument`);
  }
}

if (problems.length) {
  console.error('SPEC DRIFT:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log(
  `spec drift OK: ${found.length} implemented route(s) all declared (${declared.size} declared).`,
);
