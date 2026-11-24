import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderAccessProfile, renderPackage } from './packages';

const SCRIPT = join(__dirname, '../../../../../../../infra/hosting/node-setup.sh');
let dir = '';
let bin = '';
let log = '';
const base = () => [
  '--packages-dir',
  join(dir, 'pkgs'),
  '--access-profile',
  join(dir, 'profile'),
  '--allow-ip',
  '203.0.113.10,203.0.113.11',
  '--backup-host-type',
  'sftp',
  '--backup-host',
  'backup-sa.example.com',
  '--backup-user',
  'nuzm-backup',
  '--backup-password-file',
  join(dir, 'bh-pass'),
  '--backup-path',
  '/nuzm/node-a',
  '--backup-port',
  '22',
];
const run = (args: string[]) =>
  spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, HESTIA_BIN: bin, HESTIA_DATA: join(dir, 'data') },
    encoding: 'utf8',
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuzm-node-'));
  bin = join(dir, 'bin');
  log = join(dir, 'calls.log');
  mkdirSync(bin);
  mkdirSync(join(dir, 'pkgs'));
  mkdirSync(join(dir, 'data'));
  // stubs of the Hestia CLI: they only record that they were called (the dry run must call only the read-only ones)
  for (const c of [
    'v-list-sys-info',
    'v-list-user-packages',
    'v-add-user-package',
    'v-add-access-key',
    'v-change-sys-api',
    'v-add-sys-api-ip',
    'v-add-backup-host',
    'v-list-cron-jobs',
    'v-delete-cron-job',
  ]) {
    writeFileSync(
      join(bin, c),
      `#!/usr/bin/env bash\necho "${c} $*" >> "${log}"\ncase "${c}" in v-list-user-packages) echo "nz-old 1";; v-list-sys-info) echo "HESTIA 1.9.4";; esac\n`,
    );
    chmodSync(join(bin, c), 0o755);
  }
  writeFileSync(
    join(dir, 'pkgs/nz-web.pkg'),
    renderPackage({
      key: 'web',
      quotas: { diskMb: 100, bandwidthGb: 1, dbCount: 1, sitesCount: 1 },
    }).file,
  );
  writeFileSync(join(dir, 'profile'), renderAccessProfile());
  writeFileSync(join(dir, 'bh-pass'), 'x');
  chmodSync(join(dir, 'bh-pass'), 0o600);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('infra/hosting/node-setup.sh', () => {
  it('a dry run lists every step, never runs a mutating Hestia command and never prints the backup password', () => {
    writeFileSync(join(dir, 'bh-pass'), 'SuperSecretBackupPassword');
    chmodSync(join(dir, 'bh-pass'), 0o600);
    writeFileSync(log, '');
    const r = run([...base(), '--disable-hestia-nightly-backups', '--dry-run']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[dry-run] v-add-user-package');
    expect(r.stdout).toContain('[dry-run] install profile');
    expect(r.stdout).toContain('[dry-run] v-add-access-key admin nuzm-hosting');
    expect(r.stdout).toContain('[dry-run] v-change-sys-api enable');
    expect(r.stdout).toContain('[dry-run] v-add-sys-api-ip 203.0.113.10');
    expect(r.stdout).toContain('[dry-run] v-add-sys-api-ip 203.0.113.11');
    expect(r.stdout).not.toMatch(/allow-all/);
    expect(r.stdout).toContain(
      '[dry-run] v-add-backup-host sftp backup-sa.example.com nuzm-backup <password from file> /nuzm/node-a 22',
    );
    expect(r.stdout).toContain('hidepid');
    expect(r.stdout + r.stderr).not.toContain('SuperSecretBackupPassword');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toMatch(/^v-list-sys-info/m);
    expect(calls).not.toMatch(/v-add-|v-change-|v-delete-/); // only reads
  });

  it('refuses arguments that could be shell fragments or are malformed', () => {
    for (const [flag, bad] of [
      ['--allow-ip', '1.2.3.4; rm -rf /'],
      ['--backup-host', 'host;reboot'],
      ['--backup-user', 'a b'],
      ['--backup-path', 'relative/../path'],
      ['--backup-port', '22; id'],
      ['--backup-host-type', 'scp'],
    ] as const) {
      const args = base();
      args[args.indexOf(flag) + 1] = bad;
      const r = run([...args, '--dry-run']);
      expect(r.status, `${flag} ${bad}`).toBe(2);
      expect(readFileSync(log, 'utf8')).not.toMatch(/v-add-backup-host/);
    }
  });

  it('refuses to run without Hestia and without the required arguments, and a real run needs root and a 600 password file', () => {
    expect(run([]).status).toBe(2);
    const noHestia = spawnSync('bash', [SCRIPT, ...base(), '--dry-run'], {
      env: { ...process.env, HESTIA_BIN: join(dir, 'nowhere') },
      encoding: 'utf8',
    });
    expect(noHestia.status).toBe(1);
    expect(noHestia.stderr).toContain('HestiaCP is not installed');
    if (process.getuid?.() !== 0) expect(run(base()).stderr).toContain('run as root');
  });
});
