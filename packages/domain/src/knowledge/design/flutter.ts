import { longestLine } from '../components/dart';
import { lines } from '../detect/util';
import {
  DESIGN_LIMITS as L,
  categoryOf,
  cleanName,
  cleanValue,
  emptyDesignFacts,
  type DesignFileFacts,
  type TokenFact,
} from './types';

/**
 * Lexical reader of Flutter theme code (S-K4, interim until the bundled grammar of D-45 is selected): colours (`Color(0xFF…)`, `Color.fromARGB`, `Color.fromRGBO`), the colour
 * scheme and theme data parameters, text styles, font families, border radii, and the brightness a `ThemeData` is built for. Line oriented and linear; it reads what regular
 * theme code declares and nothing else. Named colours (`Colors.blue`) are kept as written, not resolved. The SDK is never run and nothing is imported.
 */
const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, '0');
const COLOR =
  /(?:const\s+)?Color\(\s*0x([0-9a-fA-F]{6}|[0-9a-fA-F]{8})\s*\)|(?:const\s+)?Color\.fromARGB\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)|(?:const\s+)?Color\.fromRGBO\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*([\d.]+)\s*\)|(Colors\.[A-Za-z]+(?:\.shade\d{2,3}|\[\d{2,3}\])?)/;
function colorOf(s: string): string | null {
  const m = COLOR.exec(s);
  if (!m) return null;
  if (m[1]) {
    const h = m[1].toLowerCase();
    return h.length === 8
      ? h.startsWith('ff')
        ? `#${h.slice(2)}`
        : `#${h.slice(2)}${h.slice(0, 2)}`
      : `#${h}`;
  }
  if (m[2] !== undefined)
    return `#${hex2(+m[3]!)}${hex2(+m[4]!)}${hex2(+m[5]!)}${+m[2] >= 255 ? '' : hex2(+m[2])}`;
  if (m[6] !== undefined)
    return `#${hex2(+m[6]!)}${hex2(+m[7]!)}${hex2(+m[8]!)}${+m[9]! >= 1 ? '' : hex2(+m[9]! * 255)}`;
  return m[10] ?? null;
}
const stripLineComment = (l: string): string => {
  const i = l.indexOf('//');
  if (i < 0) return l;
  const before = l.slice(0, i);
  return (before.match(/['"]/g)?.length ?? 0) % 2 === 0 ? before : l;
};

export function analyzeFlutterTheme(src: string, _path: string): DesignFileFacts {
  const f = emptyDesignFacts('dart-theme');
  if (longestLine(src) > L.maxLine) return emptyDesignFacts('dart-theme', 'minified');
  if (src.includes('\u0000')) return emptyDesignFacts('dart-theme', 'parse_error');
  const out = new Map<string, TokenFact>();
  const add = (name: string, value: string | null, line: number, mode: string, dyn = false) => {
    const n = cleanName(name);
    const v = dyn ? '' : cleanValue(value);
    if (!n || (v === null && !dyn)) return;
    const key = `${mode}\u0000${n}\u0000${v}`;
    if (out.has(key)) return;
    if (out.size >= L.maxTokensPerFile) {
      f.truncated = true;
      return;
    }
    out.set(key, {
      category: categoryOf(n, v ?? ''),
      name: n,
      value: v ?? '',
      mode,
      line,
      origin: 'flutter-theme',
      dynamic: dyn,
    });
  };
  let cls = '';
  let mode = 'base';
  let style: { name: string; left: number } | null = null;
  for (const [n, raw] of lines(src, 20_000)) {
    const l = stripLineComment(raw);
    if (!l.trim()) continue;
    const c = /^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/.exec(l);
    if (c) cls = c[1]!;
    if (
      /\bThemeData\.dark\s*\(|brightness\s*:\s*Brightness\.dark|ColorScheme\.dark\s*\(|\.fromSeed\([^)]*brightness\s*:\s*Brightness\.dark/.test(
        l,
      )
    )
      mode = 'dark';
    else if (
      /\bThemeData\.light\s*\(|brightness\s*:\s*Brightness\.light|ColorScheme\.light\s*\(/.test(l)
    )
      mode = 'light';
    else if (/\bThemeData\s*\(/.test(l) && !/brightness/.test(l)) mode = 'base';

    // `static const Color primary = Color(0xFF…);` (name qualified by its class), `const kPrimary = Color(…)`
    const decl = /^\s*(?:static\s+)?(?:const|final)\s+(?:Color\s+)?(\w+)\s*=\s*(.+)$/.exec(l);
    if (decl) {
      const v = colorOf(decl[2]!);
      if (v) add(cls && /^[A-Z]/.test(cls) ? `${cls}.${decl[1]}` : decl[1]!, v, n, mode);
    }
    // named parameters: `primary: Color(…)`, `seedColor: Color(…)`, `scaffoldBackgroundColor: …`
    for (const m of l.matchAll(
      /\b(\w+)\s*:\s*((?:const\s+)?Color(?:\.\w+)?\([^)]*\)|Colors\.[A-Za-z]+(?:\.shade\d{2,3}|\[\d{2,3}\])?)/g,
    )) {
      const v = colorOf(m[2]!);
      if (v) add(m[1]!, v, n, mode);
    }
    const ff = /\bfontFamily\s*:\s*['"]([^'"]{1,60})['"]/.exec(l);
    if (ff) add('fontFamily', ff[1]!, n, mode);
    const gf = /\bGoogleFonts\.(\w+)\s*\(/.exec(l);
    if (gf) add('fontFamily', `GoogleFonts.${gf[1]}`, n, mode);
    const mat3 = /\buseMaterial3\s*:\s*(true|false)/.exec(l);
    if (mat3) add('useMaterial3', mat3[1]!, n, mode);
    for (const r of l.matchAll(
      /BorderRadius\.(?:circular|all\(\s*Radius\.circular)\(\s*([\d.]+)\s*\)/g,
    ))
      add(`borderRadius.${r[1]}`, `${r[1]}px`, n, mode);
    // text styles: `bodyLarge: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)`; the style name applies until the call closes
    const ts = /\b(\w+)\s*:\s*(?:const\s+)?TextStyle\s*\(/.exec(l);
    if (ts) style = { name: ts[1]!, left: 0 };
    if (style) {
      const fs = /\bfontSize\s*:\s*([\d.]+)/.exec(l);
      if (fs) add(`${style.name}.fontSize`, `${fs[1]}px`, n, mode);
      const fw = /\bfontWeight\s*:\s*FontWeight\.(w\d{3}|bold|normal)/.exec(l);
      if (fw) add(`${style.name}.fontWeight`, fw[1]!, n, mode);
      const lh = /\bheight\s*:\s*([\d.]+)/.exec(l);
      if (lh) add(`${style.name}.lineHeight`, lh[1]!, n, mode);
      style.left += (l.match(/\(/g)?.length ?? 0) - (l.match(/\)/g)?.length ?? 0);
      if (style.left <= 0 && !ts) style = null;
      else if (ts && style.left <= 0) style = null;
    }
  }
  f.tokens = [...out.values()].sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : 1));
  return f;
}
