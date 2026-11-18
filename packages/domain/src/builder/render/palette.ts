import type { SiteModel } from '../site-model';
import { AA_NORMAL, bestBlackOrWhite, contrastRatio, hexOr, mix } from './contrast';

export const DEFAULT_COLORS = {
  primary: '#1d4ed8',
  accent: '#b45309',
  background: '#ffffff',
  text: '#111827',
} as const;

export interface Palette {
  bg: string;
  text: string;
  primary: string;
  onPrimary: string;
  accent: string;
  onAccent: string;
  mutedBg: string;
  mutedText: string;
  link: string;
  border: string;
}
export interface ContrastIssue {
  pair: string;
  fg: string;
  bg: string;
  ratio: number;
  required: number;
}

/**
 * Derives every colour the stylesheet uses from the four brand colours so each text/background pair that occurs in the markup meets WCAG AA (4.5:1):
 * on-primary/on-accent are black or white, muted background/text, and the link colour are nudged until they pass against both page backgrounds.
 * The only pair the user controls directly is text-on-background; if it fails, text becomes black or white and an issue is reported.
 */
export function computePalette(model: SiteModel): { palette: Palette; issues: ContrastIssue[] } {
  const c = model.brand.colors ?? {};
  const bg = hexOr(c.background, DEFAULT_COLORS.background);
  const primary = hexOr(c.primary, DEFAULT_COLORS.primary);
  const accent = hexOr(c.accent, DEFAULT_COLORS.accent);
  const wantedText = hexOr(c.text, DEFAULT_COLORS.text);
  const issues: ContrastIssue[] = [];
  let text = wantedText;
  const ratio = contrastRatio(wantedText, bg);
  if (ratio < AA_NORMAL) {
    issues.push({
      pair: 'text-on-background',
      fg: wantedText,
      bg,
      ratio: Math.round(ratio * 100) / 100,
      required: AA_NORMAL,
    });
    text = bestBlackOrWhite(bg);
  }
  const mutedBg =
    [0.06, 0.04, 0.02]
      .map((t) => mix(bg, text, t))
      .find((m) => contrastRatio(text, m) >= AA_NORMAL) ?? bg;
  const ok = (fg: string) =>
    contrastRatio(fg, bg) >= AA_NORMAL && contrastRatio(fg, mutedBg) >= AA_NORMAL;
  const mutedText =
    [0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05].map((t) => mix(text, bg, t)).find(ok) ?? text;
  const link =
    [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((t) => mix(primary, text, t)).find(ok) ??
    text;
  return {
    palette: {
      bg,
      text,
      primary,
      onPrimary: bestBlackOrWhite(primary),
      accent,
      onAccent: bestBlackOrWhite(accent),
      mutedBg,
      mutedText,
      link,
      border: mix(bg, text, 0.25),
    },
    issues,
  };
}
