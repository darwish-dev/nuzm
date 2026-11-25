const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';
const dev = process.env.NODE_ENV !== 'production';
// The builder preview runs on an ISOLATED origin `<token>.<previewDomain>` (ADR-021; same variables as the API). Only that registrable domain may be framed.
// In development the dev stack serves previews at `http://<token>.preview.localhost:<port>/` (`*.localhost` resolves to this machine), so those are the defaults here too.
const previewDomain = (
  process.env.BUILDER_PREVIEW_DOMAIN ?? (dev ? 'preview.localhost' : 'preview.nuzm-preview.test')
).toLowerCase();
const previewScheme =
  (process.env.BUILDER_PREVIEW_SCHEME ?? (dev ? 'http' : 'https')) === 'http' ? 'http' : 'https';

/**
 * Security headers (M01 §9.7). The CSP keeps `'unsafe-inline'` for scripts because Next.js emits inline hydration
 * scripts without nonces; moving to nonce-based CSP is tracked as hardening for M12. `connect-src 'self'` is enough
 * because the browser only talks to this origin (the API is proxied below).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src 'self' ${previewScheme}://*.${previewDomain}${dev ? ':*' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@nuzm/i18n', '@nuzm/ui', '@nuzm/sdk'],
  poweredByHeader: false,
  // dev only: the local stack is opened at 127.0.0.1 (the OIDC redirect and cookies use it); without this Next blocks its
  // client scripts there, the pages never hydrate and the dev hot-reload socket fails.
  allowedDevOrigins: ['127.0.0.1'],
  // The staff sign-in lives in the admin console on its own origin; these paths point there so nobody has to remember the port.
  async redirects() {
    const admin = process.env.ADMIN_ORIGIN ?? 'http://127.0.0.1:3001';
    return [
      { source: '/admin', destination: `${admin}/ar/login`, permanent: false },
      { source: '/:locale(ar|en)/admin', destination: `${admin}/:locale/login`, permanent: false },
    ];
  },
  // The browser talks to the API through this origin, so session cookies are first-party and no CORS is needed.
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${api}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          // the microphone is allowed for this origin only: chat dictation in the builder (it starts only when the person presses the mic);
          // previews and any other origin stay blocked, as do the camera and location
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};
export default nextConfig;
