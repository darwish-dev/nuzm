import { extractSymbols, isCodePath, parseImports } from '../code-intel';

/** A compact stand-in for a file when the whole text does not fit: imports and symbols for code, top-level keys for JSON, the first lines for anything else. */
export function outlineFile(path: string, text: string, maxChars = 1200): string {
  let out: string;
  if (isCodePath(path)) {
    const imports = [...new Set(parseImports(text).map((i) => i.spec))].slice(0, 20);
    const syms = extractSymbols(path, text).slice(0, 40);
    out = [
      `outline of ${path} (${text.split('\n').length} lines)`,
      imports.length ? `imports: ${imports.join(', ')}` : '',
      ...syms.map((s) => `${s.line}: ${s.exported ? 'export ' : ''}${s.kind} ${s.name}`),
    ]
      .filter(Boolean)
      .join('\n');
  } else if (path.endsWith('.json')) {
    try {
      const j = JSON.parse(text) as unknown;
      out = `outline of ${path}: ` + (j && typeof j === 'object' ? `keys ${Object.keys(j as object).slice(0, 30).join(', ')}` : typeof j);
    } catch {
      out = `outline of ${path}: not valid JSON`;
    }
  } else out = `outline of ${path}\n${text.split('\n').slice(0, 8).join('\n')}`;
  return out.length > maxChars ? out.slice(0, maxChars) + '\n[outline cut]' : out;
}
