/**
 * Health checks of the local services, used by scripts/e2e-runner.mjs and scripts/local-platform.sh. A check passes only on the EXPECTED answer:
 *  - a console: its sign-in page, reached through exactly the redirects it is known to make (each destination on the same origin and at the expected path),
 *    ending in 200 with the real sign-in form. Any other redirect, status or page fails; redirects are never followed blindly.
 *  - the sign-in service: its discovery document names itself as issuer and publishes signing keys, and the API starts a sign-in at it with the console's callback.
 * CLI: node scripts/service-health.mjs console <web|admin> <origin> | signin <apiOrigin> <idpOrigin> <webOrigin>   (exit 0 healthy, 1 with the reason)
 */
import { pathToFileURL } from 'node:url';

const { fetch, URL, AbortSignal } = globalThis;

/**
 * The sign-in routes as they are today (verified 2026-11-25): the customer console carries no language in its routes, the admin console still does and sends
 * `/login` to its default language. A change of either must be made here on purpose.
 */
export const CONSOLES = {
  web: { path: '/login', redirects: [], signInLink: /href="\/v1\/auth\/oidc\/login\?returnTo=/ },
  admin: {
    path: '/login',
    redirects: ['/ar/login'],
    signInLink: /href="\/v1\/auth\/oidc\/login\?realm=admin&(amp;)?returnTo=/,
  },
};

const get = (url, timeoutMs) =>
  fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
const reason = (e) => e?.cause?.code ?? e?.cause?.message ?? e?.name ?? String(e);

/** `null` when healthy, else a sentence that says what was expected and what happened. */
export async function checkConsole(kind, origin, { timeoutMs = 20_000 } = {}) {
  const spec = CONSOLES[kind];
  if (!spec) return `unknown console ${kind}`;
  const base = new URL(origin);
  let url = new URL(spec.path, base);
  try {
    for (const expected of spec.redirects) {
      const r = await get(url, timeoutMs);
      if (![302, 303, 307, 308].includes(r.status))
        return `${url.pathname}: expected a redirect to ${expected}, answered ${r.status}`;
      const location = r.headers.get('location');
      if (!location) return `${url.pathname}: a redirect without a destination`;
      const next = new URL(location, url);
      if (next.origin !== base.origin)
        return `${url.pathname}: redirected to another origin (${next.origin})`;
      if (next.pathname !== expected || next.search)
        return `${url.pathname}: expected a redirect to ${expected}, got ${next.pathname}${next.search}`;
      url = next;
    }
    const page = await get(url, timeoutMs);
    if (page.status !== 200) return `${url.pathname}: expected 200, answered ${page.status}`;
    const html = await page.text();
    if (!/<html[^>]*\blang="(ar|en)"/.test(html)) return `${url.pathname}: not a console page`;
    if (!html.includes('type="password"')) return `${url.pathname}: no password field`;
    if (!spec.signInLink.test(html)) return `${url.pathname}: no ${kind} sign-in link`;
    return null;
  } catch (e) {
    return `${url.pathname}: ${reason(e)}`;
  }
}

export async function checkSignIn(api, idp, web, { timeoutMs = 20_000 } = {}) {
  try {
    const d = await get(`${idp}/.well-known/openid-configuration`, timeoutMs);
    if (d.status !== 200) return `sign-in service discovery answered ${d.status}`;
    const doc = await d.json();
    if (doc.issuer !== idp) return `sign-in service issuer is ${doc.issuer}, expected ${idp}`;
    const keys = await get(doc.jwks_uri, timeoutMs);
    if (keys.status !== 200 || !(await keys.json()).keys?.length)
      return 'sign-in service publishes no signing key';
    const start = await get(
      `${api}/v1/auth/oidc/login?returnTo=${encodeURIComponent(`${web}/`)}`,
      timeoutMs,
    );
    if (start.status !== 302) return `API sign-in start answered ${start.status}, expected 302`;
    const to = new URL(start.headers.get('location') ?? '', api);
    if (`${to.origin}${to.pathname}` !== doc.authorization_endpoint)
      return `API sign-in start went to ${to.origin}${to.pathname}`;
    if (to.searchParams.get('redirect_uri') !== `${web}/v1/auth/oidc/callback`)
      return `API sign-in callback is ${to.searchParams.get('redirect_uri')}`;
    if (!to.searchParams.get('state') || to.searchParams.get('code_challenge_method') !== 'S256')
      return 'API sign-in start lacks state or PKCE';
    return null;
  } catch (e) {
    return `sign-in: ${reason(e)}`;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [what, ...a] = process.argv.slice(2);
  const bad =
    what === 'console'
      ? await checkConsole(a[0], a[1])
      : what === 'signin'
        ? await checkSignIn(a[0], a[1], a[2])
        : 'usage: service-health.mjs console <web|admin> <origin> | signin <api> <idp> <web>';
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
}
