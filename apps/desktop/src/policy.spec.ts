import { describe, expect, it } from 'vitest';
import {
  decideNavigation,
  devWebOrigin,
  loginUrl,
  parseOrigin,
  pickLocale,
  resolveConfig,
  switchLocaleUrl,
  type ShellConfig,
} from './policy';
import { parseSettings } from './settings';
import { allStrings } from './strings';

const cfg: ShellConfig = {
  webOrigin: 'https://console.nuzm.test',
  authOrigins: ['https://id.nuzm.test'],
};

describe('origin parsing', () => {
  it('accepts https and loopback http, normalising to the origin', () => {
    expect(parseOrigin('https://console.nuzm.test/some/path')).toBe('https://console.nuzm.test');
    expect(parseOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(parseOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
    expect(parseOrigin('http://app.localhost:3000')).toBe('http://app.localhost:3000');
  });
  it('rejects plain http to a remote host and non-web schemes', () => {
    expect(() => parseOrigin('http://console.nuzm.test')).toThrow(/https/);
    expect(() => parseOrigin('file:///etc/passwd')).toThrow();
    expect(() => parseOrigin('javascript:alert(1)')).toThrow();
    expect(() => parseOrigin('not a url')).toThrow(/Invalid origin/);
  });
});

describe('config resolution', () => {
  it('defaults to the local console', () => {
    expect(resolveConfig({ argv: [], env: {} })).toEqual({
      webOrigin: devWebOrigin,
      authOrigins: [],
    });
  });
  it('command line beats environment beats bundled file', () => {
    const bundled = { webOrigin: 'https://bundled.test', authOrigins: ['https://idp.test'] };
    expect(resolveConfig({ argv: [], env: {}, bundled }).webOrigin).toBe('https://bundled.test');
    expect(
      resolveConfig({ argv: [], env: { NUZM_WEB_ORIGIN: 'https://env.test' }, bundled }).webOrigin,
    ).toBe('https://env.test');
    const c = resolveConfig({
      argv: ['--origin=https://cli.test', '--auth-origin=https://idp.test/x'],
      env: {
        NUZM_WEB_ORIGIN: 'https://env.test',
        NUZM_AUTH_ORIGINS: 'https://a.test, https://b.test',
      },
      bundled,
    });
    expect(c.webOrigin).toBe('https://cli.test');
    expect(c.authOrigins).toEqual(['https://idp.test', 'https://a.test', 'https://b.test']);
  });
  it('fails closed on an insecure configured origin', () => {
    expect(() =>
      resolveConfig({ argv: [], env: { NUZM_WEB_ORIGIN: 'http://evil.test' } }),
    ).toThrow();
  });
});

describe('start page', () => {
  it('is the console login page in the chosen language', () => {
    expect(loginUrl(cfg, 'ar')).toBe('https://console.nuzm.test/login?lang=ar');
    expect(loginUrl(cfg, 'en')).toBe('https://console.nuzm.test/login?lang=en');
  });
  it('uses the stored language, else English only when the OS prefers it, else Arabic (D-32)', () => {
    expect(pickLocale('en', ['ar-SA'])).toBe('en');
    expect(pickLocale(undefined, ['en-GB', 'ar'])).toBe('en');
    expect(pickLocale(undefined, ['ar-SA'])).toBe('ar');
    expect(pickLocale(undefined, ['fr-FR'])).toBe('ar');
    expect(pickLocale('xx', [])).toBe('ar');
  });
});

describe('navigation policy', () => {
  it('keeps every console page and the sign-in provider inside the window', () => {
    for (const p of [
      '/login',
      '/console',
      '/hosting/sites',
      '/billing/invoices',
      '/v1/auth/oidc/login',
    ])
      expect(decideNavigation(cfg, `https://console.nuzm.test${p}`)).toBe('allow');
    expect(decideNavigation(cfg, 'https://id.nuzm.test/authorize?x=1')).toBe('allow');
  });
  it('opens other websites in the system browser', () => {
    expect(decideNavigation(cfg, 'https://github.com/nuzm')).toBe('external');
    // look-alike hosts and other ports are other origins
    expect(decideNavigation(cfg, 'https://console.nuzm.test.evil.test/login')).toBe('external');
    expect(decideNavigation(cfg, 'https://console.nuzm.test:8443/')).toBe('external');
    expect(decideNavigation(cfg, 'http://console.nuzm.test/')).toBe('external');
  });
  it('blocks non-web schemes', () => {
    for (const u of [
      'file:///etc/hosts',
      'javascript:alert(1)',
      'nuzm://x',
      'data:text/html,hi',
      'garbage',
    ])
      expect(decideNavigation(cfg, u)).toBe('block');
  });
});

describe('language switch', () => {
  it('keeps the person on the same console page', () => {
    expect(switchLocaleUrl(cfg, 'https://console.nuzm.test/billing?tab=2#x', 'en')).toBe(
      'https://console.nuzm.test/billing?tab=2&lang=en',
    );
    expect(switchLocaleUrl(cfg, 'https://console.nuzm.test/console?lang=en', 'ar')).toBe(
      'https://console.nuzm.test/console?lang=ar',
    );
  });
  it('falls back to the login page off the console', () => {
    expect(switchLocaleUrl(cfg, 'https://id.nuzm.test/authorize', 'en')).toBe(
      'https://console.nuzm.test/login?lang=en',
    );
  });
});

describe('settings', () => {
  it('keeps only valid fields', () => {
    expect(parseSettings(null)).toEqual({});
    expect(
      parseSettings({
        locale: 'fr',
        maximized: 'yes',
        bounds: { x: 0, y: 0, width: 10, height: 10 },
      }),
    ).toEqual({});
    expect(
      parseSettings({
        locale: 'en',
        maximized: true,
        bounds: { x: 1, y: 2, width: 1200, height: 800 },
        token: 'never-kept',
      }),
    ).toEqual({ locale: 'en', maximized: true, bounds: { x: 1, y: 2, width: 1200, height: 800 } });
  });
});

describe('shell strings', () => {
  it('Arabic and English define the same keys and placeholders', () => {
    expect(Object.keys(allStrings.ar).sort()).toEqual(Object.keys(allStrings.en).sort());
    for (const k of Object.keys(allStrings.en) as (keyof typeof allStrings.en)[]) {
      const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(allStrings.ar[k])).toEqual(ph(allStrings.en[k]));
    }
  });
});
