import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { ADMIN_OPS, type NodeOp } from './protocol';

/**
 * P3-S02: the SHORT-LIVED SIGNED REQUEST TOKEN. Every call from the control plane to a node carries one (`Authorization: NuzmNode <payload>.<signature>`), on top of mutual TLS. It
 * binds the call to: the node (`aud`), the operation, the exact body (sha256), a validity window of at most `MAX_TOKEN_TTL_S` seconds, a one-time id (`jti`, replay refused), and,
 * where the call addresses a tenant's workspace or run, the organization, workspace and handle. A stolen token therefore opens one call, once, for under a minute.
 *
 * The signing key is the control plane's and is reached through a `TokenSigner` (a vault reference resolved by the deployment; the private key is never in this repository, a config
 * file or a log). The node holds only PUBLIC keys (`TrustedControlKeys`, by key id), so a node compromise reveals nothing that signs. Algorithm: Ed25519 (RFC 8032) via node:crypto.
 */
export const TOKEN_SCHEME = 'NuzmNode';
export const MAX_TOKEN_TTL_S = 60;
export const MAX_CLOCK_SKEW_S = 5;

export interface TokenPayload {
  v: 1;
  /** control-plane signing key id */
  kid: string;
  /** the node this token is for */
  aud: string;
  op: NodeOp;
  scope: 'run' | 'admin';
  iat: number;
  exp: number;
  jti: string;
  /** sha256 hex of the exact request body bytes */
  bodySha256: string;
  orgId?: string;
  workspaceId?: string;
  handle?: string;
}
export interface TokenSigner {
  readonly keyId: string;
  sign(bytes: Buffer): Promise<Buffer> | Buffer;
}
/** public keys the node trusts for control-plane tokens, by key id (PEM SPKI). Public material only. */
export type TrustedControlKeys = Readonly<Record<string, string>>;

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export const sha256Hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** a signer over a private key supplied by the deployment (from the vault). It is only a convenience wrapper: the key bytes are not retained anywhere else. */
export class Ed25519Signer implements TokenSigner {
  private readonly key: KeyObject;
  constructor(
    readonly keyId: string,
    privateKey: KeyObject | string,
  ) {
    this.key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('signer_key_not_ed25519');
  }
  sign(bytes: Buffer): Buffer {
    return edSign(null, bytes, this.key);
  }
}

export interface TokenRequest {
  nodeId: string;
  op: NodeOp;
  body: Buffer;
  orgId?: string;
  workspaceId?: string;
  handle?: string;
  now: number;
  ttlSeconds?: number;
}
export async function signRequestToken(signer: TokenSigner, r: TokenRequest): Promise<string> {
  const ttl = Math.min(Math.max(1, r.ttlSeconds ?? 30), MAX_TOKEN_TTL_S);
  const iat = Math.floor(r.now / 1000);
  const payload: TokenPayload = {
    v: 1,
    kid: signer.keyId,
    aud: r.nodeId,
    op: r.op,
    scope: ADMIN_OPS.has(r.op) ? 'admin' : 'run',
    iat,
    exp: iat + ttl,
    jti: randomBytes(16).toString('hex'),
    bodySha256: sha256Hex(r.body),
    ...(r.orgId ? { orgId: r.orgId } : {}),
    ...(r.workspaceId ? { workspaceId: r.workspaceId } : {}),
    ...(r.handle ? { handle: r.handle } : {}),
  };
  const head = b64u(JSON.stringify(payload));
  const sig = await signer.sign(Buffer.from(head, 'utf8'));
  return `${head}.${b64u(sig)}`;
}

export type TokenVerdict =
  { ok: true; payload: TokenPayload } | { ok: false; reason: TokenRefusal };
export type TokenRefusal =
  | 'token_malformed'
  | 'token_key_unknown'
  | 'token_signature_invalid'
  | 'token_audience_mismatch'
  | 'token_operation_mismatch'
  | 'token_scope_mismatch'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'token_ttl_too_long'
  | 'token_body_mismatch'
  | 'token_replayed';

/** one-time ids seen inside their validity window; bounded, and evicting only what already expired */
export class ReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly maxEntries = 100_000) {}
  /** returns false if `jti` was already used */
  claim(jti: string, expSeconds: number, nowMs: number): boolean {
    for (const [k, e] of this.seen) if (e * 1000 < nowMs) this.seen.delete(k);
    if (this.seen.has(jti)) return false;
    // a full cache refuses new tokens rather than forgetting an unexpired id (fail closed)
    if (this.seen.size >= this.maxEntries) return false;
    this.seen.set(jti, expSeconds);
    return true;
  }
  size(): number {
    return this.seen.size;
  }
}

export interface VerifyInput {
  header: string | undefined;
  nodeId: string;
  op: NodeOp;
  body: Buffer;
  trusted: TrustedControlKeys;
  replay: ReplayCache;
  now: number;
}
export function verifyRequestToken(i: VerifyInput): TokenVerdict {
  const m = i.header ? new RegExp(`^${TOKEN_SCHEME} ([A-Za-z0-9_-]+)\\.([A-Za-z0-9_-]+)$`).exec(i.header) : null;
  if (!m) return { ok: false, reason: 'token_malformed' };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, reason: 'token_malformed' };
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.v !== 1 ||
    typeof payload.kid !== 'string' ||
    typeof payload.aud !== 'string' ||
    typeof payload.op !== 'string' ||
    typeof payload.jti !== 'string' ||
    payload.jti.length < 16 ||
    typeof payload.bodySha256 !== 'string' ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    (payload.scope !== 'run' && payload.scope !== 'admin')
  )
    return { ok: false, reason: 'token_malformed' };
  const pem = Object.prototype.hasOwnProperty.call(i.trusted, payload.kid) ? i.trusted[payload.kid] : undefined;
  if (!pem) return { ok: false, reason: 'token_key_unknown' };
  let sigOk = false;
  try {
    sigOk = edVerify(null, Buffer.from(m[1]!, 'utf8'), createPublicKey(pem), Buffer.from(m[2]!, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'token_signature_invalid' };
  if (payload.aud !== i.nodeId) return { ok: false, reason: 'token_audience_mismatch' };
  if (payload.op !== i.op) return { ok: false, reason: 'token_operation_mismatch' };
  if (payload.scope !== (ADMIN_OPS.has(i.op) ? 'admin' : 'run'))
    return { ok: false, reason: 'token_scope_mismatch' };
  const nowS = Math.floor(i.now / 1000);
  if (payload.exp - payload.iat > MAX_TOKEN_TTL_S) return { ok: false, reason: 'token_ttl_too_long' };
  if (nowS > payload.exp) return { ok: false, reason: 'token_expired' };
  if (nowS < payload.iat - MAX_CLOCK_SKEW_S) return { ok: false, reason: 'token_not_yet_valid' };
  if (payload.bodySha256 !== sha256Hex(i.body)) return { ok: false, reason: 'token_body_mismatch' };
  // claim the one-time id LAST: a request refused for any other reason does not burn it, and an accepted one can never be replayed
  if (!i.replay.claim(payload.jti, payload.exp, i.now)) return { ok: false, reason: 'token_replayed' };
  return { ok: true, payload };
}
