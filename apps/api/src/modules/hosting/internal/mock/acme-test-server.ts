/**
 * A LOCAL ACME-STYLE TEST DOUBLE for CI (M06 §2): an HTTP server on 127.0.0.1 that "issues" certificates and rate-limits like a certificate authority would
 * (a duplicate-certificate limit per domain set per week; a failed-validation limit per hour). It is NOT an RFC 8555 implementation and says nothing about how
 * Let's Encrypt behaves: real issuance goes through the node (`clpctl lets-encrypt:install:certificate`) and is BLOCKED until HG-06-01 (AC-M06-08).
 * The clock is injectable so renewal (T-30 days) can be tested with a fake clock.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import type { AcmeClient, AcmeResult } from '../ports';

export interface AcmeServerOptions {
  now?: () => Date;
  /** certificates per identical domain set per rolling 7 days */
  duplicateLimit?: number;
  validityDays?: number;
  /** domains that fail validation (DNS not pointing here) */
  failValidation?: Set<string>;
}
export class AcmeTestServer {
  private server!: Server;
  readonly issued: { domains: string[]; at: number; certificateId: string }[] = [];
  readonly requests: { domains: string[]; account: string }[] = [];
  url = '';
  constructor(readonly opts: AcmeServerOptions = {}) {}
  private now() {
    return this.opts.now?.() ?? new Date();
  }
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/issue') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        try {
          const { domains, account } = JSON.parse(body) as { domains: string[]; account: string };
          this.requests.push({ domains, account });
          const key = [...domains].sort().join(',');
          const weekAgo = this.now().getTime() - 7 * 86_400_000;
          if (domains.some((d) => this.opts.failValidation?.has(d))) {
            res
              .writeHead(400, { 'content-type': 'application/json' })
              .end(JSON.stringify({ type: 'unauthorized', detail: 'validation failed' }));
            return;
          }
          if (
            this.issued.filter((i) => [...i.domains].sort().join(',') === key && i.at > weekAgo)
              .length >= (this.opts.duplicateLimit ?? 5)
          ) {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3600' }).end(
              JSON.stringify({
                type: 'rateLimited',
                detail: 'too many certificates already issued for this domain set',
              }),
            );
            return;
          }
          const at = this.now().getTime();
          const certificateId = createHash('sha256')
            .update(`${key}|${at}|${this.issued.length}`)
            .digest('hex')
            .slice(0, 24);
          this.issued.push({ domains, at, certificateId });
          const notAfter = new Date(at + (this.opts.validityDays ?? 90) * 86_400_000).toISOString();
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ certificateId, notAfter }));
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop() {
    await new Promise((r) => this.server.close(r));
  }
}
export class AcmeHttpClient implements AcmeClient {
  constructor(private readonly url: string) {}
  async issue(domains: string[], account: string): Promise<AcmeResult> {
    const r = await fetch(`${this.url}/issue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domains, account }),
    });
    if (r.status === 429) throw new Error('rate limited by the CA');
    if (!r.ok) throw new Error(`CA refused: ${r.status}`);
    return (await r.json()) as AcmeResult;
  }
}
