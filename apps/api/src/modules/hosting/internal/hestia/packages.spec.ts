import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { RegionDirectorySink } from './directory-sink';
import { packageName, renderAccessProfile, renderPackage } from './packages';

describe('Hestia packages and the access profile', () => {
  const plan = {
    key: 'web-start',
    quotas: { diskMb: 20480, bandwidthGb: 200, dbCount: 5, sitesCount: 1, backupCount: 7 },
  };
  it('renders a package per plan with the keys Hestia ships in default.pkg, and no CPU/RAM promise', () => {
    const p = renderPackage(plan);
    expect(p.name).toBe('nz-web-start');
    expect(p.file).toContain("DISK_QUOTA='20480'\n");
    expect(p.file).toContain("BANDWIDTH='204800'\n"); // megabytes
    expect(p.file).toContain("DATABASES='5'\n");
    expect(p.file).toContain("WEB_DOMAINS='1'\n");
    expect(p.file).toContain("BACKUPS='7'\n");
    expect(p.file).toContain("SHELL='nologin'\n"); // a customer account never gets a shell
    expect(p.file).toContain("DNS_DOMAINS='0'\n"); // DNS is Nuzm's
    expect(p.file).toContain("MAIL_ACCOUNTS='0'\n");
    expect(p.file).not.toMatch(/CPU|RAM|MEMORY/i);
    expect(p.file.split('\n').every((l) => l === '' || /^[A-Z_]+='[^']*'$/.test(l))).toBe(true);
  });
  it('refuses a plan whose key cannot make a valid package name instead of truncating it', () => {
    expect(() => renderPackage({ ...plan, key: 'a'.repeat(40) })).toThrow(
      /valid Hestia package name/,
    );
    expect(packageName('x')).toBe('nz-x');
  });
  it('the committed access profile equals the allow-list of the adapter (no drift: a key cannot do more than the adapter can ask)', () => {
    const file = join(__dirname, '../../../../../../../infra/hosting/hestia/nuzm-hosting.profile');
    expect(readFileSync(file, 'utf8')).toBe(renderAccessProfile());
    expect(renderAccessProfile()).not.toMatch(
      /v-add-backup-host|v-add-user-package|v-delete-database|v-change-sys-config/,
    );
  });
});

describe('RegionDirectorySink (the off-server store as the control plane sees it)', () => {
  const SITE = 's-dddd11112222eeee';
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'nuzm-sink-'));
    await mkdir(join(root, SITE), { recursive: true });
    await writeFile(join(root, SITE, `${SITE}.2026-11-24_03-00-00.tar`), 'archive-bytes');
    return { root, sink: new RegionDirectorySink({ 'sa-central': root }) };
  }
  it('lists, measures (streamed sha256), reads and deletes inside its region root', async () => {
    const { root, sink } = await fixture();
    try {
      const ref = sink.refOf('sa-central', SITE, `${SITE}.2026-11-24_03-00-00.tar`);
      expect(await sink.list('sa-central', SITE)).toEqual([
        { name: `${SITE}.2026-11-24_03-00-00.tar`, sizeBytes: 13 },
      ]);
      expect(await sink.stat(ref)).toMatchObject({
        sizeBytes: 13,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect((await sink.get(ref))?.toString()).toBe('archive-bytes');
      expect(await sink.health('sa-central')).toEqual({ ok: true });
      expect((await sink.health('eu')).ok).toBe(false);
      expect(await sink.delete(ref)).toBe(true);
      expect(await sink.exists(ref)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('a reference can never leave its region root or reach another region', async () => {
    const { root, sink } = await fixture();
    try {
      for (const bad of [
        'sa-central/../etc/passwd',
        `sa-central/${SITE}/../../x`,
        `sa-central/${SITE}/..`,
        'sa-central/s-x/y',
        `eu/${SITE}/${SITE}.2026-11-24_03-00-00.tar`, // no such region configured
        `sa-central/${SITE}/a/b`,
        `sa-central/${SITE}/.hidden`,
      ]) {
        expect(await sink.get(bad)).toBeNull();
        expect(await sink.stat(bad)).toBeNull();
        expect(await sink.exists(bad)).toBe(false);
        expect(await sink.delete(bad)).toBe(false);
      }
      await expect(sink.put('sa-central', '../x', 'b', Buffer.from('x'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('is configured from HOSTING_BACKUP_DIR_<REGION> and is not production-ready unless the owner says so (D-07)', () => {
    const s = RegionDirectorySink.fromEnv({ HOSTING_BACKUP_DIR_SA_CENTRAL: '/srv/backup/sa' });
    expect(s?.productionReady).toBe(false);
    expect(
      RegionDirectorySink.fromEnv({
        HOSTING_BACKUP_DIR_SA_CENTRAL: '/srv/b',
        HOSTING_BACKUP_SINK_PRODUCTION: 'yes',
      })?.productionReady,
    ).toBe(true);
    expect(
      RegionDirectorySink.fromEnv({ HOSTING_BACKUP_DIR_SA_CENTRAL: 'relative/path' }),
    ).toBeNull();
    expect(RegionDirectorySink.fromEnv({})).toBeNull();
  });
});
