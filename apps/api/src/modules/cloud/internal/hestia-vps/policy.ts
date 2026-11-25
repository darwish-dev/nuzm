import { ProblemException } from '../../../../common/errors';

/**
 * Policy of the "VPS with HestiaCP installed automatically" product (S04, ADR-067 §5). Everything here is either a documented fact (cited) or a value the
 * owner/administrator decides (configuration, never a default invented here).
 *
 *  - Supported operating systems: Debian 12 and 13, Ubuntu 22.04, 24.04 and 26.04 LTS, AMD64 or ARM64 — https://hestiacp.com/docs/introduction/getting-started (read 2026-11-24).
 *  - Minimum hardware: 1 core, 1 GB memory (without SpamAssassin/ClamAV, which the template never turns on), 10 GB disk — same page.
 *  - The master prompt's first choice is Debian 12 or Ubuntu 24.04 LTS; whichever a provider offers AND states cloud-init for AND an administrator approved is what is sold.
 */
export const HESTIA_SUPPORTED_OS: Readonly<Record<'debian' | 'ubuntu', readonly string[]>> = {
  debian: ['12', '13'],
  ubuntu: ['22.04', '24.04', '26.04'],
};
export const HESTIA_MIN = { vcpu: 1, memoryMb: 1024, diskGb: 10 } as const;

export type OsId = keyof typeof HESTIA_SUPPORTED_OS;

/** "Ubuntu 24.04 64 bit", "Debian 12.5 64 bit", "ubuntu_24_04_x64": the OS and the version that matters (Debian major, Ubuntu major.minor). Anything else is not recognised. */
export function parseOsImage(name: string): { osId: OsId; osVersion: string } | null {
  const m = /(debian|ubuntu)[\s_-]*(\d{1,2})(?:[._ -](\d{1,2}))?/i.exec(name);
  if (!m) return null;
  const osId = m[1]!.toLowerCase() as OsId;
  if (osId === 'debian') return { osId, osVersion: String(Number(m[2])) };
  if (m[3] === undefined) return null;
  return { osId, osVersion: `${Number(m[2])}.${m[3].padStart(2, '0')}` };
}
export const isSupportedOs = (osId: string, osVersion: string): boolean =>
  (HESTIA_SUPPORTED_OS[osId as OsId] ?? []).includes(osVersion);

export const HESTIA_TEMPLATES = ['hestia-web', 'hestia-web-mail'] as const;
export type HestiaTemplateId = (typeof HESTIA_TEMPLATES)[number];
export interface HestiaTemplate {
  id: HestiaTemplateId;
  /** the EXPLICIT mail choice of the order: the panel's mail services (Exim, Dovecot) are installed only when true */
  mail: boolean;
}

export interface HestiaVpsConfig {
  /** the Hestia version the administrator approved; recorded on every order */
  panelVersion: string;
  /** base URL of the per-OS installer scripts (documented: https://raw.githubusercontent.com/hestiacp/hestiacp/release/install) */
  installerBaseUrl: string;
  /** SHA-256 of each per-OS installer script, computed by the administrator when approving the version. No digest for an OS = that OS is not sold. */
  installerSha256: Partial<Record<OsId, string>>;
  /** the zone whose names the panels get: `<label>.<panelDomain>` (the FQDN is fixed at order time; DNS is a separate port) */
  panelDomain: string;
  /** where the VPS reaches Nuzm's bootstrap endpoints (https, no credentials) */
  callbackBaseUrl: string;
  /** control-plane egress addresses the panel's API accepts; empty = the install does not restrict the API by address */
  controlPlaneIps: string[];
  /** sold placements: provider key + provider region. A region that is not listed is never used, and there is no fallback between them. */
  placements: { provider: string; region: string }[];
  registrationTtlMinutes: number;
  bootTimeoutMinutes: number;
  installTimeoutMinutes: number;
  readinessAttempts: number;
  holdRetryMinutes: number;
}

const bad = (m: string) => new ProblemException('validation_failed', m);
const SHA = /^[0-9a-f]{64}$/;
const FQDN = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * `HESTIA_VPS_CONFIG` (JSON). Missing or invalid = the product is NOT configured (null): nothing is offered. The defaults for the placements are the two the
 * owner named: Alibaba ECS via SCCC Riyadh (`me-central-1`) and Contabo (`EU`).
 */
export function hestiaVpsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HestiaVpsConfig | null {
  const raw = env.HESTIA_VPS_CONFIG;
  if (!raw) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  try {
    return parseHestiaVpsConfig(j);
  } catch {
    return null;
  }
}

export function parseHestiaVpsConfig(j: Record<string, unknown>): HestiaVpsConfig {
  const str = (k: string) => {
    const v = j[k];
    if (typeof v !== 'string' || !v) throw bad(`${k} is required`);
    return v;
  };
  const panelVersion = str('panelVersion');
  if (!/^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$/.test(panelVersion)) throw bad('panelVersion is invalid');
  const installerBaseUrl = str('installerBaseUrl').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]*$/.test(installerBaseUrl))
    throw bad('installerBaseUrl must be an https URL');
  const sums = (j.installerSha256 ?? {}) as Record<string, unknown>;
  const installerSha256: HestiaVpsConfig['installerSha256'] = {};
  for (const os of ['debian', 'ubuntu'] as const)
    if (sums[os] !== undefined) {
      if (typeof sums[os] !== 'string' || !SHA.test(sums[os] as string))
        throw bad(`installerSha256.${os} must be 64 lowercase hex characters`);
      installerSha256[os] = sums[os] as string;
    }
  const panelDomain = str('panelDomain').toLowerCase();
  if (!FQDN.test(panelDomain)) throw bad('panelDomain is invalid');
  const callbackBaseUrl = str('callbackBaseUrl').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._/-]*)?$/.test(callbackBaseUrl))
    throw bad('callbackBaseUrl must be an https URL without credentials');
  const ips = (j.controlPlaneIps ?? []) as unknown[];
  if (
    !Array.isArray(ips) ||
    ips.some((i) => typeof i !== 'string' || !/^[0-9a-fA-F:.]{3,45}$/.test(i))
  )
    throw bad('controlPlaneIps must be a list of addresses');
  const places = (j.placements ?? [
    { provider: 'alibaba', region: 'me-central-1' },
    { provider: 'contabo', region: 'EU' },
  ]) as { provider?: unknown; region?: unknown }[];
  if (
    !Array.isArray(places) ||
    places.some(
      (p) =>
        typeof p.provider !== 'string' ||
        typeof p.region !== 'string' ||
        !/^[a-z0-9-]{2,30}$/.test(p.provider) ||
        !/^[A-Za-z0-9-]{2,40}$/.test(p.region),
    )
  )
    throw bad('placements is invalid');
  const n = (k: string, d: number, lo: number, hi: number) => {
    const v = j[k] === undefined ? d : Number(j[k]);
    if (!Number.isInteger(v) || v < lo || v > hi) throw bad(`${k} must be ${lo}..${hi}`);
    return v;
  };
  return {
    panelVersion,
    installerBaseUrl,
    installerSha256,
    panelDomain,
    callbackBaseUrl,
    controlPlaneIps: ips as string[],
    placements: places as HestiaVpsConfig['placements'],
    registrationTtlMinutes: n('registrationTtlMinutes', 180, 10, 1440),
    bootTimeoutMinutes: n('bootTimeoutMinutes', 20, 2, 240),
    installTimeoutMinutes: n('installTimeoutMinutes', 90, 5, 480),
    readinessAttempts: n('readinessAttempts', 5, 1, 20),
    holdRetryMinutes: n('holdRetryMinutes', 30, 1, 1440),
  };
}

export interface ConfigSource {
  get(): HestiaVpsConfig | null;
}
export const envConfigSource: ConfigSource = { get: () => hestiaVpsConfigFromEnv() };

/** The explicit template choice. There is no default: the order must say whether the server runs mail. */
export function parsePanelRequest(
  raw: unknown,
): { kind: 'none' } | { kind: 'hestia'; template: HestiaTemplate } {
  if (raw === undefined || raw === null) return { kind: 'none' };
  const r = raw as { kind?: unknown; template?: unknown };
  if (typeof r !== 'object' || Array.isArray(r)) throw bad('spec.panel must be an object');
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind !== 'hestia') throw bad('spec.panel.kind must be "none" or "hestia"');
  const t = r.template as { id?: unknown; mail?: unknown } | undefined;
  if (!t || typeof t !== 'object') throw bad('spec.panel.template is required for Hestia');
  if (!(HESTIA_TEMPLATES as readonly unknown[]).includes(t.id))
    throw bad(`spec.panel.template.id must be one of ${HESTIA_TEMPLATES.join(', ')}`);
  if (typeof t.mail !== 'boolean')
    throw bad(
      'spec.panel.template.mail must be true or false: the mail service is an explicit choice',
    );
  if ((t.id === 'hestia-web-mail') !== t.mail)
    throw bad('spec.panel.template.mail does not match the template id');
  return { kind: 'hestia', template: { id: t.id as HestiaTemplateId, mail: t.mail } };
}

/** The FQDN of one server's panel, fixed at order time from the instance id (no customer text in it). */
export const panelHostFor = (instanceId: string, domain: string): string =>
  `p-${instanceId.replace(/-/g, '').slice(-16)}.${domain}`;
