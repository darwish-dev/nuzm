/**
 * Pure navigation and configuration policy for the desktop shell. No Electron imports here, so every rule is unit-tested
 * (policy.spec.ts) without starting a window.
 *
 * The shell is a thin, locked-down window around the Nuzm customer console (`apps/web`). It never holds credentials
 * itself: sign-in happens on the console's own login page, and the session cookie lives in the window's persistent
 * partition exactly as it would in a browser.
 */

export type Locale = 'ar' | 'en';

/** D-32: Arabic default, English supported. */
export const defaultLocale: Locale = 'ar';

export interface ShellConfig {
  /** Origin of the customer console (scheme + host + port), e.g. `http://127.0.0.1:3000`. */
  webOrigin: string;
  /**
   * Extra origins that may load inside the window during sign-in (the OIDC identity provider). Everything else opens in
   * the system browser.
   */
  authOrigins: string[];
}

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(u: URL): boolean {
  return loopbackHosts.has(u.hostname) || u.hostname.endsWith('.localhost');
}

/**
 * Normalise a configured origin. Only `https:` is accepted, except for loopback hosts during development, so a
 * mistyped or hostile setting can never send the sign-in page over plain HTTP.
 */
export function parseOrigin(value: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error(`Invalid origin: ${value}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u))) {
    throw new Error(`Origin must use https (http is allowed only for localhost): ${value}`);
  }
  return u.origin;
}

/** Development default: the local console started by `pnpm --filter @nuzm/web dev`. */
export const devWebOrigin = 'http://127.0.0.1:3000';

/**
 * Resolve the shell configuration. Precedence: command line (`--origin=`, `--auth-origin=`), then environment
 * (`NUZM_WEB_ORIGIN`, `NUZM_AUTH_ORIGINS` comma-separated), then the bundled `app-config.json`, then the dev default.
 */
export function resolveConfig(input: {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  bundled?: Partial<ShellConfig>;
}): ShellConfig {
  const arg = (name: string) =>
    input.argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const list = (v: string | undefined) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  const web =
    arg('origin')[0] ?? input.env.NUZM_WEB_ORIGIN ?? input.bundled?.webOrigin ?? devWebOrigin;
  const auth = [
    ...arg('auth-origin'),
    ...list(input.env.NUZM_AUTH_ORIGINS),
    ...(input.bundled?.authOrigins ?? []),
  ];
  return {
    webOrigin: parseOrigin(web),
    authOrigins: [...new Set(auth.map(parseOrigin))],
  };
}

/**
 * The first page the window shows: the console's login page. The console keeps the language in its own cookie and
 * switches it with `?lang=` on any page (apps/web/proxy.ts), so the address itself never carries a locale.
 */
export function loginUrl(config: ShellConfig, locale: Locale): string {
  return `${config.webOrigin}/login?lang=${locale}`;
}

/** Pick the starting language from the stored choice, else the OS languages (English only if the OS prefers it). */
export function pickLocale(stored: string | undefined, systemLanguages: readonly string[]): Locale {
  if (stored === 'ar' || stored === 'en') return stored;
  const first = systemLanguages[0]?.toLowerCase() ?? '';
  return first.startsWith('en') ? 'en' : defaultLocale;
}

function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * Where a top-level navigation may go. Console and sign-in pages stay in the window; other web pages open in the
 * system browser; anything that is not http(s) (file:, javascript:, custom schemes) is blocked.
 */
export function decideNavigation(config: ShellConfig, url: string): NavigationDecision {
  const origin = originOf(url);
  if (!origin) return 'block';
  if (origin === config.webOrigin || config.authOrigins.includes(origin)) return 'allow';
  return 'external';
}

/** True when the URL belongs to the console itself (used to decide which page may talk to the shell). */
export function isConsoleUrl(config: ShellConfig, url: string): boolean {
  return originOf(url) === config.webOrigin;
}

/**
 * The same console page in the other language. Every console page accepts `?lang=` (it sets the language cookie and
 * reloads the clean address), so the person stays where they are: billing stays billing, a site stays that site.
 */
export function switchLocaleUrl(config: ShellConfig, current: string, to: Locale): string {
  if (!isConsoleUrl(config, current)) return loginUrl(config, to);
  const u = new URL(current);
  u.searchParams.set('lang', to);
  u.hash = '';
  return u.toString();
}
