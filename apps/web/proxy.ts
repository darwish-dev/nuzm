import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, isLocale } from '@nuzm/i18n';

/**
 * The client dashboard lives at `/<locale>/console`. `/console` (no locale) and the bare `/<locale>` both lead there, so every older link keeps working.
 * The query string is kept (`?next=` and friends). Also exposes the request path to server layouts (for aria-current) without client JS.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const seg = pathname.split('/').filter(Boolean);
  const to = (path: string) => {
    const u = req.nextUrl.clone();
    u.pathname = path;
    return NextResponse.redirect(u);
  };
  if (seg.length === 1 && seg[0] === 'console') return to(`/${defaultLocale}/console`);
  if (seg.length === 1 && isLocale(seg[0]!)) return to(`/${seg[0]}/console`);
  const headers = new Headers(req.headers);
  headers.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers } });
}
export const config = { matcher: ['/((?!v1|_next|favicon.ico).*)'] };
