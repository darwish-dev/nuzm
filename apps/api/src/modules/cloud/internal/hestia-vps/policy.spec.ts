import { describe, expect, it } from 'vitest';
import {
  hestiaVpsConfigFromEnv,
  isSupportedOs,
  panelHostFor,
  parseHestiaVpsConfig,
  parseOsImage,
  parsePanelRequest,
} from './policy';

const BASE = {
  panelVersion: '1.10.9',
  installerBaseUrl: 'https://raw.githubusercontent.com/hestiacp/hestiacp/release/install/',
  installerSha256: { ubuntu: 'a'.repeat(64) },
  panelDomain: 'vps.example.com',
  callbackBaseUrl: 'https://api.example.com',
};

describe('HestiaCP operating-system matrix (documented: Debian 12/13, Ubuntu 22.04/24.04/26.04)', () => {
  it.each([
    ['Ubuntu 24.04 64 bit', 'ubuntu', '24.04'],
    ['ubuntu_22_04_x64', 'ubuntu', '22.04'],
    ['Debian 12.5 64 bit', 'debian', '12'],
    ['debian-13', 'debian', '13'],
    ['Ubuntu 26.04 LTS', 'ubuntu', '26.04'],
  ])('%s is recognised', (name, id, version) => {
    expect(parseOsImage(name)).toEqual({ osId: id, osVersion: version });
    expect(isSupportedOs(id, version)).toBe(true);
  });
  it.each([
    'Mock Ubuntu',
    'Alibaba Cloud Linux 3',
    'CentOS 7.9',
    'Windows Server 2022',
    'Ubuntu 24',
  ])('%s is not', (name) => {
    expect(parseOsImage(name)).toBeNull();
  });
  it('versions HestiaCP does not document are unsupported', () => {
    expect(isSupportedOs('ubuntu', '20.04')).toBe(false);
    expect(isSupportedOs('ubuntu', '23.10')).toBe(false);
    expect(isSupportedOs('debian', '11')).toBe(false);
    expect(isSupportedOs('fedora', '40')).toBe(false);
  });
});

describe('the explicit panel choice', () => {
  it('no panel = a clean VPS; Hestia needs a template with an explicit mail answer that matches it', () => {
    expect(parsePanelRequest(undefined)).toEqual({ kind: 'none' });
    expect(parsePanelRequest({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(
      parsePanelRequest({ kind: 'hestia', template: { id: 'hestia-web', mail: false } }),
    ).toEqual({ kind: 'hestia', template: { id: 'hestia-web', mail: false } });
    expect(
      parsePanelRequest({ kind: 'hestia', template: { id: 'hestia-web-mail', mail: true } }),
    ).toMatchObject({ kind: 'hestia' });
    for (const bad of [
      { kind: 'cloudpanel' },
      { kind: 'hestia' },
      { kind: 'hestia', template: { id: 'hestia-web' } },
      { kind: 'hestia', template: { id: 'hestia-web', mail: true } },
      { kind: 'hestia', template: { id: 'hestia-web-mail', mail: false } },
      { kind: 'hestia', template: { id: 'other', mail: false } },
      'hestia',
    ])
      expect(() => parsePanelRequest(bad), JSON.stringify(bad)).toThrow();
  });
});

describe('configuration (never a default invented here)', () => {
  it('missing or malformed = not configured', () => {
    expect(hestiaVpsConfigFromEnv({})).toBeNull();
    expect(hestiaVpsConfigFromEnv({ HESTIA_VPS_CONFIG: '{' })).toBeNull();
    expect(
      hestiaVpsConfigFromEnv({
        HESTIA_VPS_CONFIG: JSON.stringify({ ...BASE, panelVersion: 'latest' }),
      }),
    ).toBeNull();
    expect(
      hestiaVpsConfigFromEnv({
        HESTIA_VPS_CONFIG: JSON.stringify({ ...BASE, installerSha256: { ubuntu: 'abc' } }),
      }),
    ).toBeNull();
    expect(
      hestiaVpsConfigFromEnv({
        HESTIA_VPS_CONFIG: JSON.stringify({ ...BASE, callbackBaseUrl: 'http://api.example.com' }),
      }),
    ).toBeNull();
    expect(
      hestiaVpsConfigFromEnv({
        HESTIA_VPS_CONFIG: JSON.stringify({
          ...BASE,
          callbackBaseUrl: 'https://user:pw@api.example.com',
        }),
      }),
    ).toBeNull();
    expect(
      hestiaVpsConfigFromEnv({
        HESTIA_VPS_CONFIG: JSON.stringify({ ...BASE, installerBaseUrl: 'http://x.example.com/i' }),
      }),
    ).toBeNull();
  });
  it('the sold placements default to exactly the two the owner named; the installer digest is per OS', () => {
    const c = parseHestiaVpsConfig(BASE);
    expect(c.placements).toEqual([
      { provider: 'alibaba', region: 'me-central-1' },
      { provider: 'contabo', region: 'EU' },
    ]);
    expect(c.installerBaseUrl.endsWith('/')).toBe(false);
    expect(c.installerSha256.debian).toBeUndefined(); // no digest = that OS is not sold
    expect(c.registrationTtlMinutes).toBe(180);
  });
  it('the panel FQDN is fixed from the instance id: no customer text, no IP', () => {
    const h = panelHostFor('0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'vps.example.com');
    expect(h).toBe('p-8a9b0c1d2e3f4a5b.vps.example.com');
  });
});
