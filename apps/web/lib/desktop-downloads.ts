import 'server-only';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Where the Nuzm AI desktop installers come from. Installers are large binaries, so they never live in git. Two ways to offer them:
 *  - a public address per platform (`DESKTOP_MAC_URL`, `DESKTOP_WIN_URL`: a release page or a CDN) — the download link redirects there;
 *  - a folder on the web server (`DESKTOP_DOWNLOADS_DIR`) holding the built files (`*.dmg` for macOS, `*.exe` for Windows) — the site streams them.
 * Nothing configured means nothing is offered: the homepage keeps "Soon" (no download address is invented).
 * `DESKTOP_VERSION` names the version when it cannot be read from the file name (`Nuzm AI-0.1.0.dmg`, `Nuzm AI Setup 0.1.0.exe`).
 */
export type DesktopPlatform = 'mac' | 'windows';
/** the settings read (process.env by default) */
export type Env = Record<string, string | undefined>;
export interface DesktopDownload {
  platform: DesktopPlatform;
  /** the site's own address for it (`/download/mac`): the route redirects or streams */
  href: string;
  version: string | null;
  /** bytes, when the file is served from the folder */
  size: number | null;
}
export interface DesktopFile {
  path: string;
  name: string;
  size: number;
}

const EXT: Record<DesktopPlatform, RegExp> = { mac: /\.dmg$/i, windows: /\.exe$/i };
const URL_ENV: Record<DesktopPlatform, string> = {
  mac: 'DESKTOP_MAC_URL',
  windows: 'DESKTOP_WIN_URL',
};

/** The version in an installer name: `Nuzm AI-0.1.0.dmg` → `0.1.0`. */
export const versionOf = (name: string): string | null =>
  /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)\.(dmg|exe)$/i.exec(name)?.[1] ?? null;

/** A public https address only (never another scheme, never a relative path). */
export function publicUrl(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function dirOf(env: Env): string | null {
  const d = env.DESKTOP_DOWNLOADS_DIR?.trim();
  if (!d) return null;
  return isAbsolute(d) ? d : resolve(process.cwd(), d);
}

/** The installer file for a platform in the downloads folder (the newest one when several match), or null. */
export async function desktopFile(
  platform: DesktopPlatform,
  env: Env = process.env,
): Promise<DesktopFile | null> {
  const dir = dirOf(env);
  if (!dir) return null;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const found: (DesktopFile & { mtime: number })[] = [];
  for (const name of names) {
    // a plain file name only: no path tricks, no hidden or partial files
    if (!EXT[platform].test(name) || name.startsWith('.') || name.includes('/')) continue;
    const path = join(dir, name);
    try {
      const s = await stat(path);
      if (s.isFile()) found.push({ path, name, size: s.size, mtime: s.mtimeMs });
    } catch {
      // vanished while listing: skip it
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  const f = found[0];
  return f ? { path: f.path, name: f.name, size: f.size } : null;
}

/** What the homepage can offer, per platform. */
export async function desktopDownloads(
  env: Env = process.env,
): Promise<Partial<Record<DesktopPlatform, DesktopDownload>>> {
  const out: Partial<Record<DesktopPlatform, DesktopDownload>> = {};
  for (const platform of ['mac', 'windows'] as const) {
    const url = publicUrl(env[URL_ENV[platform]]);
    const file = url ? null : await desktopFile(platform, env);
    if (!url && !file) continue;
    out[platform] = {
      platform,
      href: `/download/${platform}`,
      version:
        env.DESKTOP_VERSION?.trim() ||
        (file ? versionOf(file.name) : null) ||
        (url ? versionOf(url) : null),
      size: file?.size ?? null,
    };
  }
  return out;
}

/** The redirect target for a platform when a public address is configured. */
export const desktopUrl = (platform: DesktopPlatform, env: Env = process.env) =>
  publicUrl(env[URL_ENV[platform]]);
