import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  buildBootstrapScript,
  buildUserData,
  installerFlags,
  newRegistration,
  parseRegistrationToken,
  secretMatches,
  type BootstrapInput,
} from './bootstrap';

const ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const reg = newRegistration(ID);
const base = (over: Partial<BootstrapInput> = {}): BootstrapInput => ({
  registrationId: ID,
  registrationSecret: reg.secret,
  callbackBaseUrl: 'https://api.example.com',
  installerBaseUrl: 'https://raw.githubusercontent.com/hestiacp/hestiacp/release/install',
  installerSha256: 'c'.repeat(64),
  osId: 'ubuntu',
  panelHost: 'p-8a9b0c1d2e3f4a5b.vps.example.com',
  panelPort: 8083,
  template: { id: 'hestia-web', mail: false },
  controlPlaneIps: ['203.0.113.10', '2001:db8::1'],
  sshPublicKeys: [
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test@example',
  ],
  ...over,
});

describe('registration secret', () => {
  it('is nzr1.<id>.<256 bits>, only its SHA-256 is kept, and the comparison is exact', () => {
    expect(reg.secret).toMatch(/^nzr1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
    expect(reg.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(secretMatches(reg.secret, reg.hash)).toBe(true);
    expect(secretMatches(reg.secret + 'x', reg.hash)).toBe(false);
    expect(secretMatches(newRegistration(ID).secret, reg.hash)).toBe(false);
    expect(newRegistration(ID).secret).not.toBe(reg.secret);
  });
  it('is read only from a Bearer header of exactly that shape', () => {
    expect(parseRegistrationToken(`Bearer ${reg.secret}`)).toEqual({
      registrationId: ID,
      secret: reg.secret,
    });
    for (const h of [
      undefined,
      '',
      reg.secret,
      `Basic ${reg.secret}`,
      `Bearer ${reg.secret}.x`,
      'Bearer nzr1.bad.token',
    ])
      expect(parseRegistrationToken(h as string)).toBeNull();
  });
});

describe('the bootstrap user data', () => {
  it('is a pure function of its input (byte-identical on a retry) and well under the 32 KB Alibaba limit', () => {
    const a = buildUserData(base());
    expect(buildUserData(base())).toBe(a);
    expect(Buffer.byteLength(a)).toBeLessThan(8 * 1024);
    expect(buildUserData(base({ template: { id: 'hestia-web-mail', mail: true } }))).not.toBe(a);
  });
  it('is valid cloud-config YAML whose script is valid bash', () => {
    const doc = parse(buildUserData(base())) as {
      write_files: { path: string; permissions: string; content: string }[];
      runcmd: unknown[];
      ssh_authorized_keys: string[];
    };
    expect(doc.ssh_authorized_keys).toHaveLength(1);
    const f = doc.write_files[0]!;
    expect(f.path).toBe('/usr/local/sbin/nuzm-bootstrap.sh');
    expect(f.permissions).toBe('0700');
    expect(f.content).toBe(buildBootstrapScript(base()));
    const dir = mkdtempSync(join(tmpdir(), 'nuzm-boot-'));
    const file = join(dir, 'boot.sh');
    writeFileSync(file, f.content);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow(); // the syntax of the script that will run as root
    expect(doc.runcmd).toHaveLength(1);
  });
  it('checks the digest of the pinned installer BEFORE running anything, then installs non-interactively and registers once', () => {
    const s = buildBootstrapScript(base());
    const iHash = s.indexOf('sha256sum -c --status');
    const iRun = s.indexOf('bash hst-install.sh');
    const iReg = s.indexOf('/register');
    expect(iHash).toBeGreaterThan(0);
    expect(iHash).toBeLessThan(iRun);
    expect(iRun).toBeLessThan(iReg);
    expect(s).toContain(`echo '${'c'.repeat(64)}  hst-install.sh'`);
    expect(s).toContain('hst-install-ubuntu.sh');
    expect(s).toContain('fail integrity_failed');
    expect(s).toContain('--interactive no');
    expect(s).toContain("REG=''"); // the secret is wiped from the shell after registering
    expect(s).toContain('API_ALLOWED_IP');
    expect(s).toContain('203.0.113.10');
    // nothing but read commands in the key profile
    expect(s).toContain("COMMANDS='v-list-sys-info,v-list-sys-php,v-list-web-templates-backend'");
    expect(s).not.toMatch(/v-add-user|v-delete|v-change-user|\*'/);
  });
  it('without control-plane addresses the allow-list step is a no-op', () => {
    expect(buildBootstrapScript(base({ controlPlaneIps: [] }))).not.toContain('API_ALLOWED_IP');
  });
  it('the template decides the services: mail on/off, never DNS, FTP or the antivirus stack', () => {
    const off = installerFlags({ id: 'hestia-web', mail: false }, 'h.example.com', 8083).join(' ');
    const on = installerFlags({ id: 'hestia-web-mail', mail: true }, 'h.example.com', 8083).join(
      ' ',
    );
    expect(off).toContain('--exim no');
    expect(off).toContain('--dovecot no');
    expect(on).toContain('--exim yes');
    expect(on).toContain('--dovecot yes');
    for (const f of [off, on]) {
      expect(f).toContain('--named no');
      expect(f).toContain('--vsftpd no');
      expect(f).toContain('--clamav no');
      expect(f).toContain('--spamassassin no');
      expect(f).toContain('--api yes');
      expect(f).toContain('--hostname h.example.com');
    }
  });
  it('refuses anything that could break out of the script (shell/YAML injection in the inputs)', () => {
    for (const over of [
      { panelHost: 'a.example.com; rm -rf /' },
      { panelHost: "a'b.example.com" },
      { callbackBaseUrl: "https://api.example.com/'; curl evil #" },
      { callbackBaseUrl: 'http://api.example.com' },
      { installerBaseUrl: 'https://x.example.com/$(id)' },
      { installerSha256: 'z'.repeat(64) },
      { installerSha256: 'a'.repeat(63) },
      { controlPlaneIps: ['1.2.3.4; id'] },
      { registrationSecret: 'nzr1.x.y' },
      { osId: 'fedora' as never },
    ])
      expect(
        () => buildBootstrapScript(base(over as Partial<BootstrapInput>)),
        JSON.stringify(over),
      ).toThrow();
  });
});
