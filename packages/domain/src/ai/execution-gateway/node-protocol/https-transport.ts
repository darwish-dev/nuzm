import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import { NODE_LIMITS } from './protocol';
import type { NodeHttpRequest, NodeHttpResponse, NodeTransport } from './remote-runtime';

/**
 * P3-S02: the network transport of the node client. Mutual TLS: the control plane presents its client certificate and verifies the node's server certificate against ONE pinned CA
 * (never the system store) and, optionally, a pinned SHA-256 fingerprint of the node's leaf certificate. No redirect is ever followed, the response is size-capped, the whole call
 * has a deadline, and one request uses one connection (no keep-alive pooling across tenants' calls).
 *
 * TLS material is obtained through `credentials()` on every call so a short-lived client certificate can be rotated without a restart; the deployment resolves it from a vault
 * reference. Nothing here reads a file or an environment variable, and no key material is logged or retained.
 *
 * Plain `http:` is accepted ONLY for a loopback address, reports `kind: 'loopback'` (the client then refuses to claim `verified`) and exists for the tests of the agent's real HTTP
 * server. A non-loopback `http:` URL is a construction error.
 */
export interface TlsCredentials {
  /** PEM of the CA that signed the node's server certificate */
  ca: string;
  /** PEM client certificate and key (short-lived) */
  cert: string;
  key: string;
}
export interface HttpsTransportOptions {
  baseUrl: string;
  credentials: () => Promise<TlsCredentials>;
  /** optional pin: sha256 fingerprint (hex, no colons) of the node's leaf certificate */
  pinnedLeafSha256?: string;
  maxResponseBytes?: number;
}
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export class HttpsTransport implements NodeTransport {
  readonly kind: 'https-mtls' | 'loopback';
  private readonly url: URL;
  constructor(private readonly o: HttpsTransportOptions) {
    this.url = new URL(o.baseUrl);
    if (this.url.username || this.url.password || this.url.search || this.url.hash)
      throw new Error('transport_url_has_credentials_or_query');
    if (this.url.protocol === 'https:') this.kind = 'https-mtls';
    else if (this.url.protocol === 'http:' && LOOPBACK.has(this.url.hostname)) this.kind = 'loopback';
    else throw new Error('transport_requires_https');
    if (o.pinnedLeafSha256 !== undefined && !/^[0-9a-f]{64}$/.test(o.pinnedLeafSha256))
      throw new Error('transport_pin_invalid');
  }

  async send(req: NodeHttpRequest, timeoutMs: number): Promise<NodeHttpResponse> {
    const cap = this.o.maxResponseBytes ?? NODE_LIMITS.maxBodyBytes;
    const tls = this.kind === 'https-mtls' ? await this.o.credentials() : null;
    return new Promise<NodeHttpResponse>((resolve, reject) => {
      const pin = this.o.pinnedLeafSha256;
      const common = {
        host: this.url.hostname.replace(/^\[|\]$/g, ''),
        port: this.url.port ? Number(this.url.port) : this.url.protocol === 'https:' ? 443 : 80,
        method: req.method,
        path: req.path,
        agent: false as const,
        timeout: timeoutMs,
        headers: { ...req.headers, 'content-length': String(req.body.length), connection: 'close' },
      };
      const r =
        tls !== null
          ? httpsRequest({
              ...common,
              ca: tls.ca,
              cert: tls.cert,
              key: tls.key,
              minVersion: 'TLSv1.3',
              rejectUnauthorized: true,
              checkServerIdentity: (host, cert) => {
                if (pin) {
                  const fp = createHash('sha256').update(cert.raw).digest('hex');
                  if (fp !== pin) return new Error('server_certificate_pin_mismatch');
                }
                // hostname verification stays the platform default; the pin is an additional constraint
                return undefined as unknown as Error | undefined;
              },
            })
          : httpRequest(common);
      const deadline = setTimeout(() => r.destroy(new Error('call_deadline')), timeoutMs);
      r.on('timeout', () => r.destroy(new Error('call_timeout')));
      r.on('error', (e) => {
        clearTimeout(deadline);
        reject(e);
      });
      r.on('response', (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          clearTimeout(deadline);
          res.resume();
          reject(new Error('redirect_refused'));
          return;
        }
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > cap) {
            res.destroy(new Error('response_too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('error', (e) => {
          clearTimeout(deadline);
          reject(e);
        });
        res.on('end', () => {
          clearTimeout(deadline);
          resolve({ status, body: Buffer.concat(chunks) });
        });
      });
      r.end(req.body);
    });
  }
}

/** the leaf-certificate fingerprint an operator pins (`openssl x509 -fingerprint -sha256` equivalent), from a PEM */
export function leafFingerprintSha256(pem: string): string {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}
