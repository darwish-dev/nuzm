import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from './policy';

/** Per-device preferences only (language, window placement). Never credentials: the session lives in the cookie jar. */
export interface Settings {
  locale?: Locale;
  maximized?: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

const fileName = 'nuzm-desktop.json';

export function parseSettings(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Settings = {};
  if (r.locale === 'ar' || r.locale === 'en') out.locale = r.locale;
  if (typeof r.maximized === 'boolean') out.maximized = r.maximized;
  const b = r.bounds as Record<string, unknown> | undefined;
  if (
    b &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) &&
    (b.width as number) >= 400 &&
    (b.height as number) >= 300
  ) {
    out.bounds = {
      x: b.x as number,
      y: b.y as number,
      width: b.width as number,
      height: b.height as number,
    };
  }
  return out;
}

export function loadSettings(dir: string): Settings {
  try {
    return parseSettings(JSON.parse(readFileSync(join(dir, fileName), 'utf8')));
  } catch {
    return {};
  }
}

export function saveSettings(dir: string, settings: Settings): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(settings, null, 2));
  } catch {
    // preferences are a convenience; failing to save them must never break the app
  }
}
