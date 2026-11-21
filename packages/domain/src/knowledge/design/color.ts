/**
 * Colour parsing and WCAG contrast, in plain arithmetic: nothing is rendered, nothing is evaluated. Returns null for anything that is not a plain opaque-or-alpha colour
 * (`color-mix()`, relative colour syntax, `currentColor`, variables): the caller reports those as unresolved instead of guessing.
 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}
const NAMED: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  maroon: '#800000',
  navy: '#000080',
  teal: '#008080',
  aqua: '#00ffff',
  cyan: '#00ffff',
  fuchsia: '#ff00ff',
  magenta: '#ff00ff',
  lime: '#00ff00',
  olive: '#808000',
  pink: '#ffc0cb',
  brown: '#a52a2a',
  transparent: '#00000000',
};
const clamp = (n: number, lo = 0, hi = 255) => Math.min(hi, Math.max(lo, n));
const num = (s: string): number | null => {
  const t = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?%?$/i.test(t)) return null;
  const v = parseFloat(t);
  return Number.isFinite(v) ? v : null;
};
const channel = (s: string): number | null => {
  const v = num(s);
  if (v === null) return null;
  return clamp(s.trim().endsWith('%') ? (v * 255) / 100 : v);
};
const alphaOf = (s: string | undefined): number | null => {
  if (s === undefined) return 1;
  const v = num(s);
  if (v === null) return null;
  return clamp(s.trim().endsWith('%') ? v / 100 : v, 0, 1);
};
const hueOf = (s: string): number | null => {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/i.exec(s.trim());
  if (!m) return null;
  const v = parseFloat(m[1]!);
  const u = (m[2] ?? 'deg').toLowerCase();
  const deg =
    u === 'turn' ? v * 360 : u === 'rad' ? (v * 180) / Math.PI : u === 'grad' ? v * 0.9 : v;
  return ((deg % 360) + 360) % 360;
};
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
function oklchToRgb(L: number, C: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (x: number) => {
    const c = clamp(x, 0, 1);
    return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
  };
  return [enc(lin[0]!), enc(lin[1]!), enc(lin[2]!)];
}
/** `parseColor('#1e88e5')`, `rgb(30 136 229 / .5)`, `hsl(222 47% 11%)`, `oklch(0.62 0.19 259)`, a basic named colour. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (!s || s.length > 120) return null;
  const named = NAMED[s];
  const t = named ?? s;
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (m) {
    let h = m[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const v = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: v(0), g: v(2), b: v(4), a: h.length === 8 ? v(6) / 255 : 1 };
  }
  m = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(t);
  if (!m) return null;
  const fn = m[1]!;
  const body = m[2]!.trim();
  if (/\b(from|var|calc|env)\b|\(/.test(body)) return null;
  const [main, slashAlpha] = body.split('/').map((x) => x.trim());
  const parts = (main ?? '').split(/[\s,]+/).filter(Boolean);
  const alphaTok = slashAlpha ?? (parts.length === 4 ? parts[3] : undefined);
  if (parts.length < 3 || parts.length > 4 || (slashAlpha !== undefined && parts.length !== 3))
    return null;
  const a = alphaOf(alphaTok);
  if (a === null) return null;
  if (fn.startsWith('rgb')) {
    const r = channel(parts[0]!);
    const g = channel(parts[1]!);
    const b = channel(parts[2]!);
    return r === null || g === null || b === null ? null : { r, g, b, a };
  }
  if (fn.startsWith('hsl')) {
    const h = hueOf(parts[0]!);
    const sat = num(parts[1]!);
    const lig = num(parts[2]!);
    if (h === null || sat === null || lig === null) return null;
    const [r, g, b] = hslToRgb(h, clamp(sat, 0, 100) / 100, clamp(lig, 0, 100) / 100);
    return { r, g, b, a };
  }
  const Lraw = num(parts[0]!);
  const C = num(parts[1]!);
  const h = hueOf(parts[2]!);
  if (Lraw === null || C === null || h === null) return null;
  const L = parts[0]!.trim().endsWith('%') ? Lraw / 100 : Lraw;
  const [r, g, b] = oklchToRgb(clamp(L, 0, 1), Math.max(0, C), h);
  return { r, g, b, a };
}
export const toHex = (c: Rgba): string => {
  const h = (n: number) => Math.round(clamp(n)).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a * 255) : ''}`;
};
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export const luminance = (c: Rgba): number =>
  0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
/** WCAG 2.x contrast ratio of two OPAQUE colours (null when either has transparency: it depends on what is behind it). Rounded to two decimals. */
export function contrast(a: Rgba, b: Rgba): number | null {
  if (a.a < 1 || b.a < 1) return null;
  const la = luminance(a);
  const lb = luminance(b);
  const r = (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  return Math.round(r * 100) / 100;
}
