import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

export interface IdpUser {
  sub: string;
  email: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Minimal in-process OIDC provider for tests (authorization-code + PKCE S256, RS256 ID tokens).
 * It is a TEST DOUBLE, not an IdP choice: D-04 stays OPEN and a real IdP is verified separately.
 * Failure knobs let tests exercise tampering and outages.
 */
export class TestIdp {
  issuer = '';
  user: IdpUser = {
    sub: 'user-1',
    email: 'user1@example.test',
    email_verified: true,
    name: 'User One',
  };
  knobs = {
    badNonce: false,
    wrongAudience: false,
    tokenStatus: 0,
    down: false,
    expiredToken: false,
  };
  private server!: Server;
  private priv!: CryptoKey;
  private jwk!: JWK;
  private codes = new Map<
    string,
    { challenge: string; nonce: string; redirectUri: string; user: IdpUser }
  >();
  readonly clientId = 'nuzm-test-client';
  readonly clientSecret = 'test-client-secret-not-real';

  /** Dev picker: when set, /authorize shows these users and signs in whoever is clicked (dev stack only). */
  pickable: IdpUser[] | null = null;

  async start(port = 0): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.priv = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', r));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) {
    if (this.knobs.down) return void req.socket.destroy();
    const url = new URL(req.url ?? '/', this.issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [this.jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (
        q.get('client_id') !== this.clientId ||
        q.get('response_type') !== 'code' ||
        q.get('code_challenge_method') !== 'S256' ||
        !q.get('code_challenge') ||
        !q.get('state') ||
        !q.get('nonce')
      ) {
        return json(400, { error: 'invalid_request' });
      }
      let user = this.user;
      if (this.pickable) {
        const sub = q.get('pick');
        const chosen = this.pickable.find((u) => u.sub === sub);
        if (!chosen) {
          const esc = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
          const items = this.pickable
            .map((u) => {
              const next = new URL(url);
              next.searchParams.set('pick', u.sub);
              return `<li><a href="${esc(next.pathname + next.search)}">${esc(u.name ?? u.sub)} &lt;${esc(u.email)}&gt;</a></li>`;
            })
            .join('');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return void res.end(
            `<!doctype html><meta charset="utf-8"><title>Dev IdP</title><h1>Dev identity provider</h1><p>Local development only. Pick a user:</p><ul>${items}</ul>`,
          );
        }
        user = chosen;
      }
      const code = randomBytes(16).toString('hex');
      this.codes.set(code, {
        challenge: q.get('code_challenge')!,
        nonce: q.get('nonce')!,
        redirectUri: q.get('redirect_uri')!,
        user,
      });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return void res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      if (this.knobs.tokenStatus) return json(this.knobs.tokenStatus, { error: 'server_error' });
      const entry = this.codes.get(f.get('code') ?? '');
      const verifierOk =
        entry &&
        createHash('sha256')
          .update(f.get('code_verifier') ?? '')
          .digest('base64url') === entry.challenge;
      if (
        !entry ||
        !verifierOk ||
        f.get('client_secret') !== this.clientSecret ||
        f.get('redirect_uri') !== entry.redirectUri
      ) {
        return json(400, { error: 'invalid_grant' });
      }
      this.codes.delete(f.get('code')!); // single use
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: this.knobs.badNonce ? 'tampered' : entry.nonce,
        email: entry.user.email,
        email_verified: entry.user.email_verified ?? true,
        name: entry.user.name,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(this.issuer)
        .setAudience(this.knobs.wrongAudience ? 'someone-else' : this.clientId)
        .setSubject(entry.user.sub)
        .setIssuedAt(now - (this.knobs.expiredToken ? 7200 : 0))
        .setExpirationTime(now + (this.knobs.expiredToken ? -3600 : 300))
        .sign(this.priv);
      return json(200, { id_token: idToken, access_token: 'unused', token_type: 'Bearer' });
    }
    json(404, { error: 'not_found' });
  }
}
