import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isLocale, type Locale } from '@nuzm/i18n';

/** Where the visitor's language is remembered. The URL never carries it: `/console`, never `/ar/console`. */
export const LOCALE_COOKIE = 'nuzm_locale';

/** Paths that are not part of the translated console: the marketing site and its static files. */
const OWN = (p: string) =>
  p === '/' ||
  p === '/designs' ||
  p.startsWith('/designs/') ||
  p.startsWith('/fonts/') ||
  /\.[a-z0-9]+$/i.test(p);

/**
 * Routes carry no language. The app's pages live under an internal `/<locale>/…` tree; this proxy picks the language (cookie → default Arabic) and
 * REWRITES to it, so the address bar shows `/console`, `/hosting/sites`, `/login`.
 *  - `?lang=en` switches the language (sets the cookie) and drops the parameter.
 *  - An old link with a language prefix (`/en/billing`, mail links) is redirected to the clean path, adopting that language.
 * Also exposes the request path to server layouts (for aria-current) without client JS.
 */
export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  const seg = pathname.split('/').filter(Boolean);
  const remember = (res: NextResponse, l: Locale) => {
    res.cookies.set(LOCALE_COOKIE, l, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
    return res;
  };
  const go = (path: string, l?: Locale, dropLang = false) => {
    const u = req.nextUrl.clone();
    u.pathname = path;
    if (dropLang) u.searchParams.delete('lang');
    const res = NextResponse.redirect(u);
    return l ? remember(res, l) : res;
  };

  // a request this proxy already rewrote (to `/<locale>/…`) must not be redirected back
  if (req.headers.get('x-nuzm-rewritten')) return NextResponse.next();
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  const lang = searchParams.get('lang');
  // the marketing home page has no `/<locale>` tree: `?lang=` sets the cookie and the page reads it itself
  if (pathname === '/' && lang && isLocale(lang)) return go('/', lang, true);
  if (OWN(pathname)) return NextResponse.next({ request: { headers } });

  if (lang && isLocale(lang)) return go(pathname, lang, true);
  // the old, prefixed address: keep its language, show the clean one
  if (seg[0] && isLocale(seg[0])) {
    const rest = seg.slice(1).join('/');
    return go(rest ? `/${rest}` : '/console', seg[0]);
  }
  const pref = req.cookies.get(LOCALE_COOKIE)?.value;
  const locale: Locale = pref && isLocale(pref) ? pref : defaultLocale;
  headers.set('x-nuzm-rewritten', '1');
  const target = req.nextUrl.clone();
  target.pathname = `/${locale}${pathname}`;
  return NextResponse.rewrite(target, { request: { headers } });
}
export const config = { matcher: ['/((?!v1|_next|favicon.ico).*)'] };
