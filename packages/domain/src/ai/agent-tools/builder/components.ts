import { analyzeImports, extractSymbols } from './code-intel';
import { isAgentSensitivePath } from '../paths';

/**
 * Reusable-component discovery (S-05): which UI components a project already has, where they live and how widely they are used, so a generation task reuses them instead of writing
 * a second copy. Static: a component is an exported function, class or const with a capitalised name in a `.tsx`/`.jsx` file (or any file under a `components` directory).
 */
export interface ComponentInfo {
  name: string;
  path: string;
  line: number;
  /** how many other project files import the file that defines it (a measure of reuse, not of exact usage) */
  importedBy: number;
}
export const COMPONENT_LIMITS = { maxResults: 200 } as const;

const CAPITAL = /^[A-Z][A-Za-z0-9]*$/;
const isUiFile = (p: string) => /\.(tsx|jsx)$/.test(p) || /(^|\/)components\//.test(p);

export function discoverComponents(files: ReadonlyMap<string, string>): ComponentInfo[] {
  const graph = analyzeImports(files).graph;
  const usedBy = new Map<string, number>();
  for (const [from, deps] of graph)
    for (const d of deps) if (d !== from) usedBy.set(d, (usedBy.get(d) ?? 0) + 1);
  const out: ComponentInfo[] = [];
  for (const [path, text] of files) {
    if (!isUiFile(path) || isAgentSensitivePath(path) || /\.(spec|test)\./.test(path)) continue;
    for (const s of extractSymbols(path, text)) {
      if (
        !s.exported ||
        !CAPITAL.test(s.name) ||
        (s.kind !== 'function' && s.kind !== 'const' && s.kind !== 'class')
      )
        continue;
      out.push({ name: s.name, path, line: s.line, importedBy: usedBy.get(path) ?? 0 });
    }
  }
  return out
    .sort(
      (a, b) =>
        b.importedBy - a.importedBy ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
        (a.path < b.path ? -1 : 1),
    )
    .slice(0, COMPONENT_LIMITS.maxResults);
}
