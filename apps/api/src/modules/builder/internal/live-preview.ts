import { tokenHash } from './preview.service';
import { previewHost, type BuilderConfig } from './model';

/** A running preview of a generated application: a child process on a loopback port, owned by one organization and project. */
export interface LivePreview {
  orgId: string;
  projectId: string;
  port: number;
  expiresAt: number;
  stop(): void;
}
export interface ProxiedResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

/** Request headers the generated application may see. Everything else (cookies, the console's authorization, forwarding headers) stays behind. */
const PASS_REQ = ['content-type', 'accept', 'accept-language', 'if-match', 'idempotency-key'];
/** Response headers passed back to the browser. */
const PASS_RES = ['content-type', 'etag', 'content-disposition', 'location'];
const MAX_BODY = 8 * 1024 * 1024;

/**
 * Live previews (ADR-063): the isolated preview origin `<token>.<previewDomain>` proxies to a running generated application. The registry knows only tokens (stored as
 * hashes) and loopback ports; the module that starts previews (the app builder) registers them here, so the builder module never depends on it. The application's own
 * session travels as `x-preview-authorization` (the preview origin strips every `authorization` header, so console credentials can never reach a preview) and is handed to
 * the child as `authorization`.
 */
export class LivePreviewRegistry {
  private readonly live = new Map<string, LivePreview>();
  constructor(
    private readonly cfg: BuilderConfig,
    private readonly now: () => number = Date.now,
  ) {}
  register(token: string, p: LivePreview): void {
    this.live.set(tokenHash(token), p);
  }
  /** Previews of one organization (newest last); expired ones are stopped first. */
  list(orgId?: string): LivePreview[] {
    this.sweep();
    return [...this.live.values()].filter((p) => orgId === undefined || p.orgId === orgId);
  }
  /** Stops every preview of a project (a new preview replaces the old one). */
  stopProject(orgId: string, projectId: string): void {
    for (const [k, p] of this.live)
      if (p.orgId === orgId && p.projectId === projectId) {
        p.stop();
        this.live.delete(k);
      }
  }
  stopAll(): void {
    for (const p of this.live.values()) p.stop();
    this.live.clear();
  }
  has(token: string): boolean {
    this.sweep();
    return this.live.has(tokenHash(token));
  }
  private sweep() {
    const t = this.now();
    for (const [k, p] of this.live)
      if (p.expiresAt <= t) {
        p.stop();
        this.live.delete(k);
      }
  }
  /** The browser address of a preview: the app's own root, with its one-time session in the fragment (never sent to a server). */
  url(token: string, session: string): string {
    const c = this.cfg;
    return `${c.previewScheme}://${previewHost(token, c)}${c.previewPort ? `:${c.previewPort}` : ''}/#/autologin=${encodeURIComponent(session)}`;
  }

  async proxy(
    host: string | undefined,
    token: string,
    method: string,
    path: string,
    query: string,
    headers: Record<string, string | string[] | undefined>,
    body: Buffer | undefined,
  ): Promise<ProxiedResponse> {
    const notFound = {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'not found',
    };
    const h = String(host ?? '')
      .toLowerCase()
      .replace(/:\d+$/, '');
    if (h !== previewHost(token, this.cfg).toLowerCase() || !this.has(token)) return notFound;
    const p = this.live.get(tokenHash(token))!;
    if (body && body.length > MAX_BODY)
      return { status: 413, headers: { 'content-type': 'text/plain' }, body: 'too large' };
    const out: Record<string, string> = {};
    for (const k of PASS_REQ) {
      const v = headers[k];
      if (typeof v === 'string') out[k] = v;
    }
    const auth = headers['x-preview-authorization'];
    if (typeof auth === 'string' && auth.length <= 2048) out.authorization = auth;
    const target = `http://127.0.0.1:${p.port}/${path.replace(/^\/+/, '')}${query ? `?${query}` : ''}`;
    let r: Response;
    try {
      r = await fetch(target, {
        method,
        headers: out,
        body: method === 'GET' || method === 'HEAD' || !body ? undefined : new Uint8Array(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: 'the preview is not running',
      };
    }
    const res: Record<string, string> = {
      // the app runs only inside the console's frame, and loads nothing from anywhere but itself
      'content-security-policy': `default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${this.cfg.consoleOrigin}; base-uri 'none'; form-action 'self'`,
      'cross-origin-resource-policy': 'same-origin',
    };
    for (const k of PASS_RES) {
      const v = r.headers.get(k);
      if (v) res[k] = v;
    }
    return { status: r.status, headers: res, body: Buffer.from(await r.arrayBuffer()) };
  }
}
