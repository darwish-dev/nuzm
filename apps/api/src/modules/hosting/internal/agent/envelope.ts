import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
  generateKeyPairSync,
  type KeyObject,
} from 'node:crypto';

/** Signed command envelope (docs/runbooks/node-agent-threat-model.md §2). Ed25519 over `nuzm-agent-cmd-v1\n` + canonical JSON of the body. */
export interface EnvelopeBody {
  v: 1;
  keyId: string;
  nodeId: string;
  operationId: string;
  idempotencyToken: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  commandId: string;
  args: Record<string, unknown>;
}
export interface Envelope {
  body: EnvelopeBody;
  /** base64 Ed25519 signature */
  signature: string;
}

export const MAX_TTL_MS = 5 * 60_000;
export const MAX_SKEW_MS = 30_000;
export const MAX_ENVELOPE_BYTES = 64 * 1024;
const DOMAIN_SEP = 'nuzm-agent-cmd-v1\n';

/** Canonical JSON: keys sorted at every level, no whitespace. `undefined` members are dropped (they do not exist in JSON). */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v))
    return `[${v.map((x) => canonicalize(x === undefined ? null : x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`)
    .join(',')}}`;
}

export const newNonce = (): string => randomBytes(16).toString('hex');
export const hashEnvelope = (e: Envelope): string =>
  createHash('sha256').update(canonicalize(e.body)).update('|').update(e.signature).digest('hex');

export interface SigningKey {
  keyId: string;
  privateKey: KeyObject;
}
export function generateSigningKey(keyId: string): { signing: SigningKey; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { signing: { keyId, privateKey }, publicKey };
}
export const privateKeyFromPem = (pem: string): KeyObject => createPrivateKey(pem);
export const publicKeyFromPem = (pem: string): KeyObject => createPublicKey(pem);

export function signEnvelope(
  key: SigningKey,
  fields: Omit<EnvelopeBody, 'v' | 'keyId' | 'nonce' | 'issuedAt' | 'expiresAt'> & {
    ttlMs?: number;
    now?: Date;
    nonce?: string;
  },
): Envelope {
  const now = fields.now ?? new Date();
  const ttl = Math.min(fields.ttlMs ?? 120_000, MAX_TTL_MS);
  const body: EnvelopeBody = {
    v: 1,
    keyId: key.keyId,
    nodeId: fields.nodeId,
    operationId: fields.operationId,
    idempotencyToken: fields.idempotencyToken,
    nonce: fields.nonce ?? newNonce(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    commandId: fields.commandId,
    args: fields.args,
  };
  const signature = sign(
    null,
    Buffer.from(DOMAIN_SEP + canonicalize(body)),
    key.privateKey,
  ).toString('base64');
  return { body, signature };
}

export type EnvelopeRejection =
  | 'malformed'
  | 'oversize'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_node'
  | 'expired'
  | 'not_yet_valid'
  | 'ttl_too_long';

/** Pure signature + window + node binding check. Replay, allow-list and schema checks are the runtime's job. */
export function verifyEnvelope(
  e: unknown,
  opts: { nodeId: string; keys: Map<string, KeyObject>; now: Date },
): { ok: true; envelope: Envelope } | { ok: false; reason: EnvelopeRejection } {
  if (typeof e !== 'object' || e === null) return { ok: false, reason: 'malformed' };
  const env = e as Envelope;
  const body = env.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof env.signature !== 'string' ||
    body.v !== 1 ||
    typeof body.keyId !== 'string' ||
    typeof body.nodeId !== 'string' ||
    typeof body.nonce !== 'string' ||
    body.nonce.length < 32 ||
    typeof body.commandId !== 'string' ||
    typeof body.operationId !== 'string' ||
    typeof body.idempotencyToken !== 'string' ||
    typeof body.args !== 'object' ||
    body.args === null ||
    Array.isArray(body.args)
  )
    return { ok: false, reason: 'malformed' };
  const text = canonicalize(body);
  if (text.length > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'oversize' };
  const key = opts.keys.get(body.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };
  let good: boolean;
  try {
    good = verify(null, Buffer.from(DOMAIN_SEP + text), key, Buffer.from(env.signature, 'base64'));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: 'bad_signature' };
  // from here the body is authentic (signed by the control plane): bind it to this node and this moment
  if (body.nodeId !== opts.nodeId) return { ok: false, reason: 'wrong_node' };
  const issued = Date.parse(body.issuedAt);
  const expires = Date.parse(body.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires))
    return { ok: false, reason: 'malformed' };
  if (expires - issued > MAX_TTL_MS) return { ok: false, reason: 'ttl_too_long' };
  const t = opts.now.getTime();
  if (t > expires) return { ok: false, reason: 'expired' };
  if (issued - t > MAX_SKEW_MS) return { ok: false, reason: 'not_yet_valid' };
  return { ok: true, envelope: env };
}
