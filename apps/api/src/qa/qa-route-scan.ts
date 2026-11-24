import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Session 07 (QA): static scan of every HTTP handler of every controller under apps/api/src (shared by the route-security QA suites). */
export type Route = { file: string; method: string; path: string; decos: string[] };
// vitest runs with the package root (apps/api) as the working directory
const SRC = `${join(process.cwd(), 'src')}/`;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (f === 'node_modules') return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const HTTP = /^\s*@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/;
export const routes = (): Route[] => {
  const out: Route[] = [];
  for (const f of walk(SRC)) {
    if (!f.endsWith('.ts') || f.endsWith('.spec.ts') || f.includes('/testing/')) continue;
    const src = readFileSync(f, 'utf8');
    if (!src.includes('@Controller(')) continue;
    const lines = src.split('\n');
    let prefix = '';
    let classDecos: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      const ctl = /^\s*@Controller\(([^)]*)\)/.exec(l);
      if (ctl) {
        prefix = ctl[1]!.replace(/['"`]/g, '');
        classDecos = [];
        for (let k = i - 1; k >= 0 && /^\s*@/.test(lines[k]!); k--)
          classDecos.push(lines[k]!.trim());
        for (let k = i + 1; k < lines.length && /^\s*@/.test(lines[k]!); k++)
          classDecos.push(lines[k]!.trim());
        continue;
      }
      const m = HTTP.exec(l);
      if (!m) continue;
      const decos: string[] = [l.trim()];
      for (let k = i - 1; k >= 0 && /^\s*@/.test(lines[k]!); k--) decos.push(lines[k]!.trim());
      for (let k = i + 1; k < lines.length && /^\s*@/.test(lines[k]!); k++)
        decos.push(lines[k]!.trim());
      out.push({
        file: f.slice(SRC.length),
        method: m[1]!.toUpperCase(),
        path: `/${prefix}/${m[2]!.replace(/['"`]/g, '')}`.replace(/\/+/g, '/').replace(/\/$/, ''),
        decos: [...decos, ...classDecos],
      });
    }
  }
  return out;
};
export const has = (r: Route, n: string) => r.decos.some((d) => d.startsWith(`@${n}(`));
export const key = (r: Route) => `${r.method} ${r.path}`;
