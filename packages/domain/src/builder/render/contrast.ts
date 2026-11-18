/** WCAG 2.x colour maths. Hex only (#rgb or #rrggbb); everything that reaches CSS is normalised through `hexOr`. */
export const AA_NORMAL = 4.5;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/** Re-validate a model colour before it is used in CSS; anything else falls back. Returns lowercase #rrggbb. */
export function hexOr(v: unknown, fallback: string): string {
  if (!isHex(v)) return fallback;
  const h = v.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}

export function parseHex(hex: string): [number, number, number] {
  if (!isHex(hex)) throw new RangeError(`not a hex colour: ${String(hex).slice(0, 20)}`);
  const h = hexOr(hex, '#000000').slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = (rgb: readonly number[]): string =>
  `#${rgb
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1..21), order independent. */
export function contrastRatio(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Linear mix in sRGB: t=0 gives `a`, t=1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex(x.map((c, i) => c * (1 - t) + (y[i] as number) * t));
}

/** Black or white, whichever reads better on `bg` (always >= 4.58:1). */
export const bestBlackOrWhite = (bg: string): '#000000' | '#ffffff' =>
  contrastRatio('#000000', bg) >= contrastRatio('#ffffff', bg) ? '#000000' : '#ffffff';
