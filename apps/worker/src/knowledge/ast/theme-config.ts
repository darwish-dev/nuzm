import ts from 'typescript';
import {
  DESIGN_LIMITS as L,
  categoryOf,
  cleanName,
  cleanValue,
  emptyDesignFacts,
  longestLine,
  type DesignFileFacts,
  type TokenFact,
  type TokenOrigin,
} from '@nuzm/domain';

/**
 * Static reader of theme configuration written as JavaScript/TypeScript (S-K4): Tailwind `theme`/`extend`, Material UI `createTheme`, Chakra `extendTheme`, and plain
 * exported token objects (`export const colors = {…}`, `theme`, `tokens`, `palette`, …). The file is only PARSED (`ts.createSourceFile`): it is never required, imported or
 * evaluated, so a configuration that runs code (plugins, `require`, spreads of imports, function calls) yields `dynamic` entries with their location, never invented values.
 * Iterative traversal under a node budget; names from the source are restricted to a safe alphabet.
 */
const MAX_NODES = 400_000;
const CALLS = new Set([
  'createTheme',
  'extendTheme',
  'createStitches',
  'defineTheme',
  'createSystem',
  'defineConfig',
]);
const VAR_NAME =
  /^(theme|tokens|designTokens|design_tokens|colou?rs|palette|spacing|fontSizes?|fontFamily|fontFamilies|typography|breakpoints|screens|radii|borderRadius|shadows|lightTheme|darkTheme|themeColors?|colorTokens|brand|brandColors)$/i;
const SKIP_KEYS = new Set([
  'plugins',
  'content',
  'safelist',
  'presets',
  'keyframes',
  'variants',
  'corePlugins',
  'prefix',
  'important',
  'separator',
  'darkMode',
  'future',
  'experimental',
  'blocklist',
  'files',
  'purge',
]);

const unwrap = (n: ts.Expression): ts.Expression => {
  let x = n;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isNonNullExpression(x)
  )
    x = x.expression;
  return x;
};
const keyOf = (n: ts.PropertyName): string | null => {
  if (
    ts.isIdentifier(n) ||
    ts.isStringLiteral(n) ||
    ts.isNumericLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n)
  )
    return n.text;
  if (ts.isComputedPropertyName(n)) {
    const e = unwrap(n.expression);
    if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
      return e.text;
  }
  return null;
};
const modeOf = (path: string[], hint: string): string => {
  const p = [hint, ...path].map((s) => s.toLowerCase());
  if (
    p.some((s) => s === 'dark' || /(^|[-_])dark(theme|mode|colors?)?$/.test(s) || /^dark/.test(s))
  )
    return 'dark';
  if (
    p.some(
      (s) => s === 'light' || /(^|[-_])light(theme|mode|colors?)?$/.test(s) || /^light/.test(s),
    )
  )
    return 'light';
  return 'base';
};

export function analyzeThemeConfig(
  text: string,
  fileName: string,
  opts: { maxNodes?: number } = {},
): DesignFileFacts {
  const f = emptyDesignFacts('theme-config');
  if (longestLine(text) > L.maxLine) return emptyDesignFacts('theme-config', 'minified');
  if (text.includes('\u0000')) return emptyDesignFacts('theme-config', 'parse_error');
  const budget = { n: 0, max: Math.min(opts.maxNodes ?? MAX_NODES, MAX_NODES) };
  const tick = () => {
    if (++budget.n > budget.max) throw new Error('budget');
  };
  const isTailwind = /(^|\/)tailwind\.config\.[cm]?[jt]s$/i.test(fileName);
  if (isTailwind) f.traits.tailwind = true;
  const kind = /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(fileName)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(fileName)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const out = new Map<string, TokenFact>();
  try {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const add = (
      path: string[],
      value: string | null,
      at: ts.Node,
      origin: TokenOrigin,
      hint: string,
    ) => {
      const name = cleanName(path.join('.'));
      if (!name) return;
      const dynamic = value === null;
      const v = dynamic ? '' : cleanValue(value);
      if (v === null) {
        f.truncated = true;
        return;
      }
      const mode = modeOf(path, hint);
      const key = `${mode}\u0000${name}`;
      if (!out.has(key) && out.size >= L.maxTokensPerFile) {
        f.truncated = true;
        return;
      }
      out.set(key, {
        category: categoryOf(name, v),
        name,
        value: v,
        mode,
        line: lineOf(at),
        origin,
        dynamic,
      });
    };

    /** Flattens one theme object: leaves become tokens, anything computed becomes a dynamic entry at its location. */
    const flatten = (
      root: ts.ObjectLiteralExpression,
      base: string[],
      origin: TokenOrigin,
      hint: string,
    ) => {
      const stack: { node: ts.ObjectLiteralExpression; path: string[]; depth: number }[] = [
        { node: root, path: base, depth: 0 },
      ];
      while (stack.length) {
        const { node, path, depth } = stack.pop()!;
        tick();
        if (depth > L.maxJsonDepth) {
          f.truncated = true;
          continue;
        }
        const props = node.properties.slice(0, 600);
        if (node.properties.length > 600) f.truncated = true;
        for (const p of [...props].reverse()) {
          tick();
          if (ts.isSpreadAssignment(p)) {
            add([...path, '$spread'], null, p, origin, hint);
            continue;
          }
          const nm = p.name ? keyOf(p.name) : null;
          if (nm === null) {
            if (p.name) add([...path, '$computed'], null, p, origin, hint);
            continue;
          }
          if (SKIP_KEYS.has(nm)) continue;
          // Tailwind's `extend` adds to the scale: it is the same scale for our purpose
          const here = nm === 'extend' ? path : [...path, nm];
          if (ts.isShorthandPropertyAssignment(p)) {
            add(here, null, p, origin, hint);
            continue;
          }
          if (!ts.isPropertyAssignment(p)) {
            add(here, null, p, origin, hint); // methods and accessors are code
            continue;
          }
          const v = unwrap(p.initializer);
          if (ts.isObjectLiteralExpression(v))
            stack.push({ node: v, path: here, depth: depth + 1 });
          else if (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v))
            add(here, v.text, p, origin, hint);
          else if (ts.isNumericLiteral(v)) add(here, v.text, p, origin, hint);
          else if (
            ts.isPrefixUnaryExpression(v) &&
            v.operator === ts.SyntaxKind.MinusToken &&
            ts.isNumericLiteral(v.operand)
          )
            add(here, `-${v.operand.text}`, p, origin, hint);
          else if (ts.isArrayLiteralExpression(v)) {
            const els = v.elements.slice(0, 12).map(unwrap);
            const strs = els.filter(
              (e): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
                ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e),
            );
            if (els.length > 0 && strs.length === els.length)
              add(here, strs.map((e) => e.text).join(', '), p, origin, hint);
            else if (
              els.length === 2 &&
              strs.length === 1 &&
              ts.isObjectLiteralExpression(els[1]!)
            ) {
              // Tailwind `fontSize: { sm: ['0.875rem', { lineHeight: '1.25rem' }] }`
              add(here, strs[0]!.text, p, origin, hint);
              flatten(
                els[1] as ts.ObjectLiteralExpression,
                [...here.slice(0, -1), `${here[here.length - 1]}-line`],
                origin,
                hint,
              );
            } else add(here, null, p, origin, hint);
          } else add(here, null, p, origin, hint); // an identifier, a call, a template with parts, a function: computed
        }
      }
    };

    // find the theme roots with one iterative walk; a found root is not walked again
    const stack: ts.Node[] = [sf];
    while (stack.length) {
      const n = stack.pop()!;
      tick();
      let handled = false;
      if (ts.isPropertyAssignment(n)) {
        const nm = keyOf(n.name);
        const v = unwrap(n.initializer);
        if (nm === 'theme' && ts.isObjectLiteralExpression(v)) {
          flatten(
            v,
            [],
            isTailwind || /tailwind/i.test(fileName) ? 'tailwind-config' : 'js-theme',
            '',
          );
          handled = true;
        }
        if (nm === 'darkMode') {
          const dv = unwrap(n.initializer);
          if (ts.isStringLiteral(dv) && dv.text === 'media') f.traits.darkMedia = true;
        }
      } else if (ts.isCallExpression(n)) {
        const callee = ts.isIdentifier(n.expression)
          ? n.expression.text
          : ts.isPropertyAccessExpression(n.expression)
            ? n.expression.name.text
            : '';
        const a0 = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
        if (CALLS.has(callee) && a0 && ts.isObjectLiteralExpression(a0)) {
          // `defineConfig({ theme: … })` is found by the property rule; the others are themes themselves
          if (callee === 'defineConfig') {
            /* descend normally */
          } else {
            const hint = /dark/i.test(text.slice(Math.max(0, n.getStart(sf) - 80), n.getStart(sf)))
              ? 'dark'
              : '';
            flatten(a0, [], 'js-theme', hint);
            handled = true;
          }
        }
      } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const v = unwrap(n.initializer);
        if (VAR_NAME.test(n.name.text) && ts.isObjectLiteralExpression(v)) {
          flatten(
            v,
            /^(theme|tokens|designTokens|design_tokens)$/i.test(n.name.text) ? [] : [n.name.text],
            isTailwind ? 'tailwind-config' : 'js-theme',
            n.name.text,
          );
          handled = true;
        }
      } else if (
        ts.isExportAssignment(n) &&
        !n.isExportEquals &&
        /(theme|tokens|colou?rs|palette)/i.test(fileName.split('/').pop() ?? '')
      ) {
        const v = unwrap(n.expression);
        if (ts.isObjectLiteralExpression(v) && !isTailwind) {
          flatten(v, [], 'js-theme', '');
          handled = true;
        }
      }
      if (!handled) ts.forEachChild(n, (c) => void stack.push(c));
    }
  } catch (e) {
    return emptyDesignFacts(
      'theme-config',
      (e as Error).message === 'budget' ? 'budget' : 'parse_error',
    );
  }
  f.tokens = [...out.values()].sort(
    (a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  return f;
}
