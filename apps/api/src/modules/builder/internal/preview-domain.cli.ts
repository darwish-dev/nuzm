/**
 * `tsx src/modules/builder/internal/preview-domain.cli.ts [--edge-config] [--live]`: validates the configured preview domain (BUILDER_PREVIEW_DOMAIN, BUILDER_PREVIEW_SCHEME,
 * BUILDER_CONSOLE_ORIGIN, BUILDER_FORMS_BASE_URL) and prints the check list. Offline by default: DNS, TLS and HTTP checks stay NOT VERIFIED. `--live` performs them against
 * the configured domain and ONLY runs when PREVIEW_DOMAIN_LIVE_APPROVED=B-DOMAIN is set (the owner decision that a preview domain and wildcard certificate exist); the probes
 * touch only a random, unowned label under that domain. Exit 0 = every check passed or was live-verified; 1 = a check failed; 3 = only NOT VERIFIED remain.
 */
import dns from 'node:dns/promises';
import tls from 'node:tls';
import { loadBuilderConfig } from './model';
import {
  renderEdgeConfig,
  runPreviewDomainValidation,
  type DomainProbes,
  type PreviewDomainConfig,
} from './preview-domain';

export function liveProbes(timeoutMs = 8000): DomainProbes {
  return {
    async resolve(host) {
      try {
        return [...(await dns.resolve4(host)), ...(await dns.resolve6(host).catch(() => []))];
      } catch (e) {
        if (
          (e as NodeJS.ErrnoException).code === 'ENOTFOUND' ||
          (e as NodeJS.ErrnoException).code === 'ENODATA'
        )
          return [];
        throw e;
      }
    },
    tlsCertificate: (host) =>
      new Promise((resolve, reject) => {
        const s = tls.connect(
          { host, port: 443, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
          () => {
            const c = s.getPeerCertificate();
            const sans = (c.subjectaltname ?? '')
              .split(',')
              .map((x) => x.trim().replace(/^DNS:/, ''))
              .filter(Boolean);
            const chainOk = s.authorized;
            s.end();
            resolve({ sans, notAfter: new Date(c.valid_to).toISOString(), chainOk });
          },
        );
        s.on('timeout', () => (s.destroy(), reject(new Error('TLS handshake timed out'))));
        s.on('error', reject);
      }),
    async get(url, headers) {
      const r = await fetch(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        status: r.status,
        headers: Object.fromEntries(r.headers.entries()),
        body: await r.text(),
      };
    },
  };
}

async function main(argv: string[]): Promise<number> {
  const b = loadBuilderConfig();
  const cfg: PreviewDomainConfig = {
    previewDomain: b.previewDomain,
    scheme: b.previewScheme,
    consoleOrigin: b.consoleOrigin,
    apiOrigin: b.formsBaseUrl,
  };
  if (argv.includes('--edge-config')) {
    console.log(renderEdgeConfig(cfg));
    return 0;
  }
  const live = argv.includes('--live');
  if (live && process.env.PREVIEW_DOMAIN_LIVE_APPROVED !== 'B-DOMAIN') {
    console.error(
      'refusing --live: set PREVIEW_DOMAIN_LIVE_APPROVED=B-DOMAIN only after the owner decided the preview domain and certificate (B-DOMAIN)',
    );
    return 2;
  }
  const r = await runPreviewDomainValidation(cfg, live ? liveProbes() : {});
  for (const c of r.checks)
    console.log(
      `${c.status.padEnd(13)} ${c.id.padEnd(10)} ${c.title}\n${' '.repeat(24)}${c.detail}`,
    );
  if (r.checks.some((c) => c.status === 'FAIL' || c.status === 'LIVE-FAILED')) return 1;
  return r.verified ? 0 : 3;
}
if (require.main === module)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e: unknown) => (console.error(e instanceof Error ? e.message : String(e)), process.exit(2)),
  );
