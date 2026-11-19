/**
 * Helpers of the Code view: a small, dependency-free syntax tint for the three kinds of file a generated site has (HTML, CSS, JavaScript), file kinds for the
 * tree, and search over file names and contents. Everything here only READS text; the tokens are rendered as React text (never as markup), so nothing in a
 * generated file can run or inject anything.
 */
import type { FileContent, SiteModel } from './builder';

export type FileKind = 'html' | 'css' | 'js' | 'json' | 'image' | 'text';
export type TokenClass = 'tag' | 'attr' | 'str' | 'com' | 'kw' | 'num' | 'prop' | 'at' | 'plain';
export interface Token {
  c: TokenClass;
  s: string;
}

export function fileKind(path: string): FileKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs') return 'js';
  if (ext === 'json') return 'json';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico'].includes(ext)) return 'image';
  return 'text';
}

const JS_KEYWORDS =
  'var|let|const|function|return|if|else|for|while|do|new|this|typeof|instanceof|in|of|true|false|null|undefined|try|catch|throw|switch|case|break|continue|default|class|extends|import|export|from|async|await';

const RULES: Record<
  'html' | 'css' | 'js' | 'json',
  { re: RegExp; cls: (m: RegExpExecArray) => TokenClass }
> = {
  html: {
    re: /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w-]*)|("[^"]*"|'[^']*')|(\s[\w:-]+(?==))/g,
    cls: (m) => (m[1] ? 'com' : m[2] ? 'tag' : m[3] ? 'str' : 'attr'),
  },
  css: {
    re: /(\/\*[\s\S]*?\*\/)|("[^"]*"|'[^']*')|(@[\w-]+)|([\w-]+(?=\s*:))|(-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg)?\b|#[0-9a-fA-F]{3,8}\b)/g,
    cls: (m) => (m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'at' : m[4] ? 'prop' : 'num'),
  },
  json: {
    re: /("(?:[^"\\\n]|\\.)*"(?=\s*:))|("(?:[^"\\\n]|\\.)*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?\b)/g,
    cls: (m) => (m[1] ? 'prop' : m[2] ? 'str' : m[3] ? 'kw' : 'num'),
  },
  js: {
    re: new RegExp(
      `(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)|("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)|\\b(${JS_KEYWORDS})\\b|(\\b\\d+(?:\\.\\d+)?\\b)`,
      'g',
    ),
    cls: (m) => (m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'kw' : 'num'),
  },
};

/** Tint one text. Unknown kinds come back as a single plain token. The tokens always concatenate back to the original text. */
export function highlight(text: string, kind: FileKind): Token[] {
  const rule =
    kind === 'html' || kind === 'css' || kind === 'js' || kind === 'json' ? RULES[kind] : null;
  if (!rule || text.length > 200_000) return [{ c: 'plain', s: text }];
  const out: Token[] = [];
  let last = 0;
  const re = new RegExp(rule.re.source, rule.re.flags);
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push({ c: 'plain', s: text.slice(last, m.index) });
    out.push({ c: rule.cls(m), s: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ c: 'plain', s: text.slice(last) });
  return out.length ? out : [{ c: 'plain', s: text }];
}

/** Split tokens into lines (a token that spans lines, such as a comment, is cut at each newline) so every line can carry its own number. */
export function toLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) lines.push([]);
      if (p !== '') lines[lines.length - 1]!.push({ c: t.c, s: p });
    });
  }
  return lines;
}

export interface SearchHit {
  path: string;
  /** 1-based line of a content match; 0 for a file-name match */
  line: number;
  text: string;
}

/** Case-insensitive search of file names and file contents (at most `limit` hits, so a broad query stays quick). */
export function searchFiles(
  files: { path: string }[],
  contents: Record<string, string>,
  query: string,
  limit = 60,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const hits: SearchHit[] = [];
  for (const f of files) {
    if (f.path.toLowerCase().includes(q)) hits.push({ path: f.path, line: 0, text: f.path });
    const body = contents[f.path];
    if (body === undefined) continue;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length && hits.length < limit; i++)
      if (lines[i]!.toLowerCase().includes(q))
        hits.push({ path: f.path, line: i + 1, text: lines[i]!.trim().slice(0, 160) });
    if (hits.length >= limit) break;
  }
  return hits.slice(0, limit);
}

/**
 * The SOURCE of a site as files, derived from its model on the client (nothing is fetched or stored): the project record, the site settings, the design tokens and
 * one file per page. They sit beside the generated files in the tree, the way a project keeps its source next to its output. They are views of the model: read-only,
 * and a change is made in the editor or by asking in the chat.
 */
export const SOURCE_PREFIXES = ['.nuzm/', 'src/'] as const;
export const isSourcePath = (path: string): boolean =>
  SOURCE_PREFIXES.some((p) => path.startsWith(p));

export function sourceFiles(
  model: SiteModel | undefined,
  info: { projectId: string; versionId: string },
): FileContent[] {
  if (!model) return [];
  const mk = (path: string, value: unknown): FileContent => {
    const content = `${JSON.stringify(value, null, 2)}\n`;
    return {
      path,
      mime: 'application/json',
      size: new TextEncoder().encode(content).length,
      encoding: 'utf8',
      content,
    };
  };
  return [
    mk('.nuzm/project.json', {
      projectId: info.projectId,
      versionId: info.versionId,
      locales: model.locales,
      defaultLocale: model.defaultLocale,
      pages: model.pages.map((p) => p.slug),
    }),
    mk('src/site.json', {
      brand: model.brand,
      seo: model.seo,
      nav: model.nav,
      footer: model.footer,
      forms: model.forms,
      assets: model.assets ?? [],
    }),
    mk('src/tokens.json', model.tokens),
    ...model.pages.map((p) => mk(`src/pages/${p.slug}.json`, p)),
  ];
}
