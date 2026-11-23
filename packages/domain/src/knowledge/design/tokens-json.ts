import { longestLine } from '../components/dart';
import {
  DESIGN_LIMITS as L,
  categoryOf,
  cleanName,
  cleanValue,
  emptyDesignFacts,
  type DesignFileFacts,
  type TokenCategory,
  type TokenFact,
} from './types';

/**
 * Static reader of design-token JSON (S-K4): W3C design tokens (`$value`/`$type`), Style Dictionary (`value`/`type`), WordPress `theme.json` presets (arrays of `{ slug, … }`)
 * and plain nested token objects. JSON is data: it is parsed with `JSON.parse` and walked iteratively under a node budget and a depth limit. Keys are only ever read, never
 * assigned into an object, so `__proto__` and friends are harmless. A `{alias.path}` reference is kept as the value and resolved (or reported) when the design is assembled.
 */
const TYPE_HINT: Record<string, TokenCategory> = {
  color: 'color',
  dimension: 'spacing',
  fontfamily: 'typography',
  fontweight: 'typography',
  fontsize: 'typography',
  lineheight: 'typography',
  letterspacing: 'typography',
  typography: 'typography',
  duration: 'motion',
  cubicbezier: 'motion',
  shadow: 'shadow',
  borderradius: 'radius',
  radius: 'radius',
  spacing: 'spacing',
  breakpoint: 'breakpoint',
};
const PRESET_VALUE = ['color', 'size', 'fontFamily', 'shadow', 'gradient', 'value'] as const;
const modeOf = (path: string[]): string => {
  const p = path.map((s) => s.toLowerCase());
  if (p.includes('dark') || p.some((s) => /(^|[-_])dark$/.test(s))) return 'dark';
  if (p.includes('light') || p.some((s) => /(^|[-_])light$/.test(s))) return 'light';
  return 'base';
};

export function analyzeTokensJson(src: string, _path: string): DesignFileFacts {
  const f = emptyDesignFacts('tokens-json');
  if (longestLine(src) > 400_000) return emptyDesignFacts('tokens-json', 'minified');
  if (src.includes('\u0000')) return emptyDesignFacts('tokens-json', 'parse_error');
  let root: unknown;
  try {
    root = JSON.parse(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src);
  } catch {
    return emptyDesignFacts('tokens-json', 'parse_error');
  }
  if (root === null || typeof root !== 'object')
    return emptyDesignFacts('tokens-json', 'parse_error');

  const out = new Map<string, TokenFact>();
  const add = (path: string[], value: unknown, hint: TokenCategory | null) => {
    const name = cleanName(path.join('.'));
    const v = cleanValue(value);
    if (!name || v === null) {
      if (name) f.truncated = true;
      return;
    }
    const mode = modeOf(path);
    const key = `${mode}\u0000${name}`;
    if (!out.has(key) && out.size >= L.maxTokensPerFile) {
      f.truncated = true;
      return;
    }
    out.set(key, {
      category: hint ?? categoryOf(name, v),
      name,
      value: v,
      mode,
      line: 1, // JSON has no meaningful line for a nested key; the path is the evidence
      origin: 'tokens-json',
      dynamic: false,
    });
  };

  interface Item {
    node: unknown;
    path: string[];
    depth: number;
    hint: TokenCategory | null;
  }
  const stack: Item[] = [{ node: root, path: [], depth: 0, hint: null }];
  let nodes = 0;
  while (stack.length) {
    const { node, path, depth, hint } = stack.pop()!;
    if (++nodes > L.maxJsonNodes) {
      f.truncated = true;
      break;
    }
    if (node === null || typeof node !== 'object') {
      if ((typeof node === 'string' || typeof node === 'number') && path.length)
        add(path, node, hint);
      continue;
    }
    if (depth > L.maxJsonDepth) {
      f.truncated = true;
      continue;
    }
    if (Array.isArray(node)) {
      node.slice(0, 400).forEach((el, i) => {
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          const slug = (el as Record<string, unknown>).slug;
          if (typeof slug === 'string') {
            for (const k of PRESET_VALUE) {
              const val = (el as Record<string, unknown>)[k];
              if (typeof val === 'string' || typeof val === 'number') {
                add([...path, slug], val, null);
                return;
              }
            }
            return;
          }
        }
        stack.push({ node: el, path: [...path, String(i)], depth: depth + 1, hint });
      });
      continue;
    }
    const o = node as Record<string, unknown>;
    const keys = Object.keys(o);
    const rawType = (o.$type ?? o.type) as unknown;
    const here: TokenCategory | null =
      typeof rawType === 'string'
        ? (TYPE_HINT[rawType.replace(/[-_ ]/g, '').toLowerCase()] ?? hint)
        : hint;
    const leaf = '$value' in o ? o.$value : 'value' in o && keys.length <= 8 ? o.value : undefined;
    if (leaf !== undefined) {
      if (typeof leaf === 'string' || typeof leaf === 'number') add(path, leaf, here);
      else if (leaf && typeof leaf === 'object')
        stack.push({ node: leaf, path, depth: depth + 1, hint: here });
      continue;
    }
    if (keys.length > 600) f.truncated = true;
    for (const k of keys.slice(0, 600).reverse()) {
      if (k.startsWith('$') || k === 'description' || k === 'comment' || k === 'extensions')
        continue;
      stack.push({ node: o[k], path: [...path, k], depth: depth + 1, hint: here });
    }
  }
  f.tokens = [...out.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return f;
}
