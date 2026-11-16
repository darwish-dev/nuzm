const api = process.env.API_ORIGIN ?? 'http://127.0.0.1:4000';
const dev = process.env.NODE_ENV !== 'production';

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
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@nuzm/i18n', '@nuzm/ui', '@nuzm/sdk'],
  poweredByHeader: false,
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
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default nextConfig;
