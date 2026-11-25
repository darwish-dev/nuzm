import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export const MIN_PASSWORD_LENGTH = 10;

/** `s1$<salt hex>$<key hex>`: scrypt (N=16384, r=8, p=1). Plain passwords are never stored or logged. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return 's1$' + salt.toString('hex') + '$' + key.toString('hex');
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 's1') return false;
  const salt = Buffer.from(parts[1] as string, 'hex');
  const expected = Buffer.from(parts[2] as string, 'hex');
  const actual = await scryptAsync(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function b64(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}
/** `<payload>.<hmac>`: a signed, expiring session token (no server-side state). */
export function signToken(
  secret: string,
  userId: string,
  ttlSeconds: number,
  nowMs: number,
): string {
  // `jti` identifies the session so that logout can revoke it server-side (the token itself is otherwise stateless)
  const payload = b64(
    JSON.stringify({
      uid: userId,
      exp: Math.floor(nowMs / 1000) + ttlSeconds,
      jti: randomBytes(16).toString('hex'),
    }),
  );
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + mac;
}
export interface Session {
  uid: string;
  /** absent only in tokens issued before revocation existed; such a token cannot be revoked and expires on its own */
  jti: string | null;
  /** expiry, seconds since the epoch */
  exp: number;
}
export function readSession(secret: string, token: string, nowMs: number): Session | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid?: unknown;
      exp?: unknown;
      jti?: unknown;
    };
    if (typeof p.uid !== 'string' || typeof p.exp !== 'number' || p.exp * 1000 < nowMs) return null;
    return { uid: p.uid, exp: p.exp, jti: typeof p.jti === 'string' ? p.jti : null };
  } catch {
    return null;
  }
}
export function verifyToken(secret: string, token: string, nowMs: number): string | null {
  return readSession(secret, token, nowMs)?.uid ?? null;
}
