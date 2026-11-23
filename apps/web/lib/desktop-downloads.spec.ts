import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { desktopDownloads, desktopFile, desktopUrl, publicUrl, versionOf } =
  await import('./desktop-downloads');

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nuzm-desktop-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('desktop downloads', () => {
  it('reads the version from the installer name', () => {
    expect(versionOf('Nuzm AI-0.1.0.dmg')).toBe('0.1.0');
    expect(versionOf('Nuzm AI Setup 1.2.3-beta.1.exe')).toBe('1.2.3-beta.1');
    expect(versionOf('Nuzm.dmg')).toBeNull();
  });

  it('accepts only public https addresses', () => {
    expect(publicUrl('https://cdn.example.com/Nuzm.dmg')).toBe('https://cdn.example.com/Nuzm.dmg');
    expect(publicUrl('http://cdn.example.com/Nuzm.dmg')).toBeNull();
    expect(publicUrl('javascript:alert(1)')).toBeNull();
    expect(publicUrl('/local/file.dmg')).toBeNull();
    expect(publicUrl(undefined)).toBeNull();
  });

  it('offers nothing when nothing is configured (the homepage keeps "Soon")', async () => {
    expect(await desktopDownloads({})).toEqual({});
  });

  it('serves the newest installer of each platform from the downloads folder', async () => {
    await writeFile(join(dir, 'Nuzm AI-0.1.0.dmg'), 'old');
    await writeFile(join(dir, 'Nuzm AI-0.2.0.dmg'), 'newer-mac');
    await writeFile(join(dir, 'Nuzm AI Setup 0.2.0.exe'), 'win');
    await writeFile(join(dir, '.hidden.dmg'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dir, 'Nuzm AI-0.1.0.dmg'), old, old);
    const env = { DESKTOP_DOWNLOADS_DIR: dir };
    expect((await desktopFile('mac', env))?.name).toBe('Nuzm AI-0.2.0.dmg');
    expect(await desktopDownloads(env)).toEqual({
      mac: { platform: 'mac', href: '/download/mac', version: '0.2.0', size: 9 },
      windows: { platform: 'windows', href: '/download/windows', version: '0.2.0', size: 3 },
    });
  });

  it('prefers a configured public address, and ignores a folder that does not exist', async () => {
    const env = {
      DESKTOP_MAC_URL: 'https://releases.example.com/Nuzm%20AI-0.3.0.dmg',
      DESKTOP_DOWNLOADS_DIR: join(dir, 'missing'),
    };
    expect(desktopUrl('mac', env)).toBe('https://releases.example.com/Nuzm%20AI-0.3.0.dmg');
    expect(await desktopDownloads(env)).toEqual({
      mac: { platform: 'mac', href: '/download/mac', version: '0.3.0', size: null },
    });
  });
});
