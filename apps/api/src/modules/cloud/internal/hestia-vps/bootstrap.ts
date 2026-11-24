import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HESTIA_SUPPORTED_OS, type HestiaTemplate, type OsId } from './policy';

/**
 * The first-boot bootstrap of a Hestia VPS: a cloud-init `#cloud-config` document (Alibaba: Linux user data via cloud-init, Base64 ≤ 32 KB before encoding —
 * https://www.alibabacloud.com/help/en/ecs/user-guide/customize-the-initialization-configuration-for-an-instance; Contabo: the `userData` create field, documented as cloud-init for standard images —
 * https://api.contabo.com/). It is a PURE function of its input, so a retry of the same provision sends byte-identical user data (Alibaba rejects a replayed ClientToken whose parameters changed).
 *
 * What the script does, in order, and reports to Nuzm (`/v1/bootstrap/panel/events`, authenticated by the registration secret):
 *   1. `booted`            the script runs (the server is up and cloud-init works);
 *   2. download the PINNED per-OS Hestia installer and check its SHA-256 BEFORE running it (`integrity_failed` stops everything: nothing unverified is executed);
 *   3. `installing`        run `hst-install-<os>.sh` non-interactively with the documented flags (https://hestiacp.com/docs/introduction/getting-started);
 *   4. create a READ-ONLY access key through a custom command profile (https://hestiacp.com/docs/server-administration/rest-api) — the customer has root, Nuzm only ever needs to read;
 *   5. register (`/v1/bootstrap/panel/register`): panel version, host, port, TLS fingerprint and the key, once; the secret dies with it.
 * The admin password of the panel is generated ON the server and left in a root-only file for the customer; it is never sent to Nuzm.
 *
 * NOT VERIFIED live: the `v-add-access-key` JSON field names and the `API_ALLOWED_IP` setting name (Hestia's own sources, not the cited pages) — the script reports `key_failed` rather than guessing.
 */

export const READ_ONLY_PROFILE = 'nuzm-readonly';
/** exactly the read commands the readiness probe uses; anything else is refused by the panel (and the readiness test proves it) */
export const READ_ONLY_COMMANDS = [
  'v-list-sys-info',
  'v-list-sys-php',
  'v-list-web-templates-backend',
] as const;

export interface BootstrapInput {
  registrationId: string;
  registrationSecret: string;
  callbackBaseUrl: string;
  installerBaseUrl: string;
  installerSha256: string;
  osId: OsId;
  panelHost: string;
  panelPort: number;
  template: HestiaTemplate;
  controlPlaneIps: string[];
  sshPublicKeys: string[];
}

const SAFE = {
  token: /^nzr1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/,
  url: /^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._/-]*)?$/,
  host: /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  ip: /^[0-9a-fA-F:.]{3,45}$/,
  sha: /^[0-9a-f]{64}$/,
};

/** A fresh registration: the secret is `nzr1.<registration id>.<256 random bits>`; only its SHA-256 is kept in the database. */
export function newRegistration(registrationId: string): { secret: string; hash: string } {
  const secret = `nzr1.${registrationId}.${randomBytes(32).toString('base64url')}`;
  return { secret, hash: hashSecret(secret) };
}
export const hashSecret = (secret: string): string =>
  createHash('sha256').update(secret).digest('hex');
export function parseRegistrationToken(
  header: string | undefined,
): { registrationId: string; secret: string } | null {
  const m = /^Bearer (nzr1\.([0-9a-f-]{36})\.[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  return m ? { registrationId: m[2]!, secret: m[1]! } : null;
}
export function secretMatches(secret: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Hestia's documented installer flags for the template. Roles: a customer VPS runs web + database; DNS (`named`), FTP and the antivirus stack are not installed. */
export function installerFlags(t: HestiaTemplate, panelHost: string, panelPort: number): string[] {
  const yn = (b: boolean) => (b ? 'yes' : 'no');
  return [
    '--interactive no',
    `--hostname ${panelHost}`,
    `--email postmaster@${panelHost}`,
    '--password "$ADMIN_PW"',
    `--port ${panelPort}`,
    '--lang en',
    '--apache no',
    '--phpfpm yes',
    '--multiphp no',
    '--mysql yes',
    '--named no',
    '--vsftpd no',
    '--proftpd no',
    '--clamav no',
    '--spamassassin no',
    `--exim ${yn(t.mail)}`,
    `--dovecot ${yn(t.mail)}`,
    '--iptables yes',
    '--fail2ban yes',
    '--api yes',
  ];
}

export function buildBootstrapScript(i: BootstrapInput): string {
  if (!SAFE.token.test(i.registrationSecret)) throw new Error('invalid registration secret');
  for (const [k, ok] of [
    ['callbackBaseUrl', SAFE.url.test(i.callbackBaseUrl)],
    ['installerBaseUrl', SAFE.url.test(i.installerBaseUrl)],
    ['installerSha256', SAFE.sha.test(i.installerSha256)],
    ['panelHost', SAFE.host.test(i.panelHost)],
    ['controlPlaneIps', i.controlPlaneIps.every((x) => SAFE.ip.test(x))],
    ['osId', i.osId in HESTIA_SUPPORTED_OS],
  ] as const)
    if (!ok) throw new Error(`invalid bootstrap input: ${k}`);
  const api = `${i.callbackBaseUrl}/v1/bootstrap/panel`;
  const flags = installerFlags(i.template, i.panelHost, i.panelPort).join(' ');
  const profile = `ROLE='admin'\\nCOMMANDS='${READ_ONLY_COMMANDS.join(',')}'\\n`;
  const allow = i.controlPlaneIps.join('\\n');
  return `#!/bin/bash
# Nuzm bootstrap: installs HestiaCP ${i.osId} from a pinned, digest-checked installer and registers the panel once.
set -u
umask 077
REG='${i.registrationSecret}'
API='${api}'
report() { # phase [code]
  curl --silent --show-error --max-time 30 --retry 5 --retry-delay 10 --retry-connrefused \\
    -H "Authorization: Bearer $REG" -H 'content-type: application/json' \\
    -d "{\\"phase\\":\\"$1\\",\\"code\\":\\"\${2:-}\\"}" "$API/events" >/dev/null 2>&1 || true
}
fail() { report failed "$1"; exit 1; }
report booted
cd /root || fail no_root_home
curl --fail --silent --show-error --location --max-time 120 --retry 3 -o hst-install.sh '${i.installerBaseUrl}/hst-install-${i.osId}.sh' || fail download_failed
echo '${i.installerSha256}  hst-install.sh' | sha256sum -c --status - || { rm -f hst-install.sh; fail integrity_failed; }
report installer_verified
ADMIN_PW="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)"
[ \${#ADMIN_PW} -ge 16 ] || fail password_failed
printf '%s\\n' "$ADMIN_PW" > /root/.nuzm-panel-admin-password
report installing
bash hst-install.sh ${flags} >/var/log/nuzm-hestia-install.log 2>&1 || fail install_failed
rm -f hst-install.sh
. /etc/profile.d/hestia.sh 2>/dev/null || true
printf '${profile}' > /usr/local/hestia/data/api/${READ_ONLY_PROFILE} || fail profile_failed
${i.controlPlaneIps.length ? `/usr/local/hestia/bin/v-change-sys-config-value 'API_ALLOWED_IP' "$(printf '${allow}')" >/dev/null 2>&1 || report note allowlist_not_applied` : ':'}
KEYOUT="$(/usr/local/hestia/bin/v-add-access-key admin ${READ_ONLY_PROFILE} nuzm json 2>/dev/null)" || fail key_failed
KID="$(printf '%s' "$KEYOUT" | sed -n 's/.*"ACCESS_KEY_ID"[^"]*"\\([A-Za-z0-9]*\\)".*/\\1/p' | head -n1)"
KSEC="$(printf '%s' "$KEYOUT" | sed -n 's/.*"SECRET_ACCESS_KEY"[^"]*"\\([A-Za-z0-9._-]*\\)".*/\\1/p' | head -n1)"
[ -n "$KID" ] && [ -n "$KSEC" ] || fail key_failed
PIN="$(openssl s_client -connect 127.0.0.1:${i.panelPort} </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//')"
VER="$(/usr/local/hestia/bin/v-list-sys-info json 2>/dev/null | sed -n 's/.*"HESTIA"[^"]*"\\([0-9.]*\\)".*/\\1/p' | head -n1)"
[ -n "$PIN" ] && [ -n "$VER" ] || fail probe_failed
curl --fail --silent --show-error --max-time 30 --retry 8 --retry-delay 15 --retry-connrefused \\
  -H "Authorization: Bearer $REG" -H 'content-type: application/json' \\
  -d "{\\"panelVersion\\":\\"$VER\\",\\"host\\":\\"${i.panelHost}\\",\\"port\\":${i.panelPort},\\"tlsFingerprintSha256\\":\\"$PIN\\",\\"accessKey\\":\\"$KID:$KSEC\\"}" \\
  "$API/register" >/dev/null 2>&1 || fail register_failed
REG=''
rm -f /var/lib/cloud/instance/user-data.txt /var/lib/cloud/instance/scripts/* 2>/dev/null || true
exit 0
`;
}

/** The complete `#cloud-config`: the script as a root-only file, run once at first boot, plus the customer's SSH keys. */
export function buildUserData(i: BootstrapInput): string {
  const script = buildBootstrapScript(i);
  const indent = script
    .split('\n')
    .map((l) => (l.length ? `      ${l}` : ''))
    .join('\n');
  const keys = i.sshPublicKeys.length
    ? `ssh_authorized_keys:\n${i.sshPublicKeys.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\n`
    : '';
  return `#cloud-config
${keys}write_files:
  - path: /usr/local/sbin/nuzm-bootstrap.sh
    permissions: '0700'
    owner: root:root
    content: |
${indent}
runcmd:
  - [ bash, -c, 'nohup /usr/local/sbin/nuzm-bootstrap.sh >/var/log/nuzm-bootstrap.log 2>&1 &' ]
`;
}
