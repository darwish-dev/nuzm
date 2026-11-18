import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { safeFetch, type HttpResponseLike, type SafeFetchDeps } from '@nuzm/domain';

/** Production wiring of the SSRF-safe fetcher: DNS through the OS resolver (ALL records, so a mixed answer is refused), connection pinned to the vetted address. */
export const nodeFetchDeps: SafeFetchDeps = {
  resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  request: (url, connectTo, signal) =>
    new Promise<HttpResponseLike>((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(
        {
          host: connectTo,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: {
            host: url.host,
            'user-agent': 'NuzmFetcher/1',
            accept: 'text/html,text/plain,application/xhtml+xml',
          },
          servername: url.hostname,
          signal,
        },
        (res) => {
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get: (n) =>
                Array.isArray(res.headers[n.toLowerCase()])
                  ? (res.headers[n.toLowerCase()] as string[])[0]!
                  : ((res.headers[n.toLowerCase()] as string | undefined) ?? null),
            },
            readBody: (max) =>
              new Promise((ok, bad) => {
                const chunks: Buffer[] = [];
                let n = 0;
                res.on('data', (c: Buffer) => {
                  n += c.length;
                  if (n > max) {
                    res.destroy();
                    ok({ bytes: new Uint8Array(Buffer.concat(chunks)), truncated: true });
                  } else chunks.push(c);
                });
                res.on('end', () =>
                  ok({ bytes: new Uint8Array(Buffer.concat(chunks)), truncated: false }),
                );
                res.on('error', bad);
              }),
          });
        },
      );
      req.on('error', reject);
      req.end();
    }),
};

export abstract class UrlFetchPort {
  abstract fetch(url: string): Promise<{ url: string; body: Uint8Array }>;
}
export class SafeUrlFetcher extends UrlFetchPort {
  constructor(private readonly deps: SafeFetchDeps = nodeFetchDeps) {
    super();
  }
  async fetch(url: string) {
    const r = await safeFetch(url, this.deps);
    return { url: r.url, body: r.body };
  }
}

/** Reduce fetched HTML to plain text: scripts, styles and COMMENTS (a favourite place for hidden instructions) are removed with their content, tags are dropped. */
export function htmlToText(html: string, max = 20_000): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
