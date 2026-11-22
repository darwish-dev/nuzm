import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const go = (path: string, cookie?: string) =>
  proxy(
    new NextRequest(`http://localhost:3000${path}`, {
      headers: cookie ? { cookie: `nuzm_locale=${cookie}` } : {},
    }),
  );
const rewritten = (r: Response) => r.headers.get('x-middleware-rewrite');

describe('proxy: routes carry no language', () => {
  it('serves /console from the default (Arabic) tree, or the remembered language, without changing the address', () => {
    expect(new URL(rewritten(go('/console'))!).pathname).toBe('/ar/console');
    expect(new URL(rewritten(go('/hosting/sites', 'en'))!).pathname).toBe('/en/hosting/sites');
    expect(go('/console').status).toBe(200);
  });
  it('ignores a cookie that is not a supported language', () => {
    expect(new URL(rewritten(go('/login', 'fr'))!).pathname).toBe('/ar/login');
  });
  it('redirects an old prefixed address to the clean one and remembers its language', () => {
    const r = go('/en/billing/wallet?x=1');
    expect(r.status).toBe(307);
    const u = new URL(r.headers.get('location')!);
    expect(u.pathname + u.search).toBe('/billing/wallet?x=1');
    expect(r.headers.get('set-cookie')).toContain('nuzm_locale=en');
    expect(new URL(go('/ar').headers.get('location')!).pathname).toBe('/console');
  });
  it('?lang= switches the language, sets the cookie and drops the parameter', () => {
    const r = go('/billing?lang=en&a=1');
    const u = new URL(r.headers.get('location')!);
    expect(u.pathname + u.search).toBe('/billing?a=1');
    expect(r.headers.get('set-cookie')).toContain('nuzm_locale=en');
  });
  it('?lang= on the home page sets the cookie and comes back to / (the page reads the cookie itself)', () => {
    const r = go('/?lang=ar');
    expect(r.status).toBe(307);
    expect(
      new URL(r.headers.get('location')!).pathname + new URL(r.headers.get('location')!).search,
    ).toBe('/');
    expect(r.headers.get('set-cookie')).toContain('nuzm_locale=ar');
    // an unsupported language is ignored
    expect(go('/?lang=fr').headers.get('location')).toBeNull();
  });
  it('leaves the marketing site and static files alone', () => {
    for (const p of ['/', '/designs', '/designs/ai.html', '/fonts/identity/fonts.css', '/x.png']) {
      const r = go(p);
      expect(r.headers.get('location')).toBeNull();
      expect(rewritten(r)).toBeNull();
    }
  });
});
