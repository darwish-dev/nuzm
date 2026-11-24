import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { SiteObservation, SiteProbe } from '../ports';

interface Answer {
  status: number;
  location: string;
  body: string;
}

/**
 * Looks at a site over HTTP the way a visitor would, but against the NODE (its fixed panel FQDN) with the site's name as Host/SNI: DNS for a new domain may not point there yet.
 * It only ever sends two GET requests, never follows a redirect and carries no secret, so skipping certificate validation on the HTTPS retry (a fresh site has no certificate
 * for its name yet) exposes nothing. WordPress answers a request for any page with a redirect to `wp-admin/setup-config.php` (no wp-config.php) or `wp-admin/install.php`
 * (configured, not installed); an installed one serves `wp-login.php` with its `wp-submit` button. Anything else (Hestia's default page, 404) is `none`.
 */
export class HttpSiteProbe implements SiteProbe {
  constructor(
    private readonly o: {
      hostOf: (nodeId: string) => Promise<string | null>;
      httpPort?: number;
      httpsPort?: number;
      timeoutMs?: number;
    },
  ) {}

  private get(
    host: string,
    port: number,
    tls: boolean,
    domain: string,
    path: string,
  ): Promise<Answer | null> {
    return new Promise((resolve) => {
      const opts = {
        host,
        port,
        path,
        method: 'GET',
        headers: { host: domain, 'user-agent': 'nuzm-site-probe/1', accept: 'text/html' },
        ...(tls ? { servername: domain, rejectUnauthorized: false } : {}),
      };
      const req = (tls ? httpsRequest : httpRequest)(opts, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 200_000) req.destroy();
          else chunks.push(c);
        });
        const end = () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers.location ?? ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        res.on('end', end);
        res.on('close', end);
      });
      req.setTimeout(this.o.timeoutMs ?? 8000, () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  async observe(nodeId: string, domain: string): Promise<SiteObservation> {
    const host = await this.o.hostOf(nodeId);
    if (!host)
      return {
        answers: false,
        phase: 'none',
        adminPage: false,
        detail: 'the node has no panel host',
      };
    const http = this.o.httpPort ?? 80;
    const https = this.o.httpsPort ?? 443;
    let tls = false;
    let root = await this.get(host, http, false, domain, '/');
    if (
      root &&
      [301, 302, 307, 308].includes(root.status) &&
      root.location.startsWith(`https://${domain}`) &&
      !/wp-admin\//.test(root.location)
    ) {
      tls = true;
      root = await this.get(host, https, true, domain, '/');
    }
    if (!root)
      return { answers: false, phase: 'none', adminPage: false, detail: 'the node did not answer' };
    if (/wp-admin\/setup-config\.php/.test(root.location))
      return {
        answers: true,
        phase: 'unconfigured',
        adminPage: false,
        detail: 'redirect to setup-config.php',
      };
    if (/wp-admin\/install\.php/.test(root.location))
      return {
        answers: true,
        phase: 'uninstalled',
        adminPage: false,
        detail: 'redirect to install.php',
      };
    const login = await this.get(host, tls ? https : http, tls, domain, '/wp-login.php');
    const admin =
      !!login && login.status === 200 && /name="wp-submit"|id="wp-submit"/.test(login.body);
    return admin
      ? { answers: true, phase: 'installed', adminPage: true, detail: 'wp-login.php is served' }
      : {
          answers: true,
          phase: 'none',
          adminPage: false,
          detail: `no WordPress (home ${root.status})`,
        };
  }
}
