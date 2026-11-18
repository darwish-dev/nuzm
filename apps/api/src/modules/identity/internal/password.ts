import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing and policy (ADR-008). scrypt (OWASP-listed, in Node's core): the cost parameters live inside the stored
 * string `scrypt$N$r$p$salt$hash`, so they can be raised later without a migration and old hashes keep verifying.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const KEY_LEN = 32;
const MAXMEM = 256 * 1024 * 1024;

const scryptAsync = (pw: string, salt: Buffer, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(pw.normalize('NFKC'), salt, KEY_LEN, o, (e, k) => (e ? reject(e) : resolve(k))),
  );

export interface ScryptCost {
  /** log2 of N; production default 17 (128 MiB). Tests use a smaller value. */
  logN: number;
  r: number;
  p: number;
}
export const DEFAULT_COST: ScryptCost = { logN: 17, r: 8, p: 1 };

export async function hashPassword(pw: string, cost: ScryptCost = DEFAULT_COST): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, {
    N: 2 ** cost.logN,
    r: cost.r,
    p: cost.p,
    maxmem: MAXMEM,
  });
  return `scrypt$${2 ** cost.logN}$${cost.r}$${cost.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Constant-time verification; a malformed or out-of-range stored value is simply "no match". */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !saltB64 || !keyB64) return false;
  const N = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  if (
    !Number.isInteger(Math.log2(N)) ||
    N < 2 ** 10 ||
    N > 2 ** 20 ||
    rr < 1 ||
    rr > 32 ||
    pp < 1 ||
    pp > 8
  )
    return false;
  const want = Buffer.from(keyB64, 'base64');
  const got = await scryptAsync(pw, Buffer.from(saltB64, 'base64'), {
    N,
    r: rr,
    p: pp,
    maxmem: MAXMEM,
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

// A deliberately short deny-list of the passwords people choose most; length 12+ already removes most of them.
const COMMON = new Set([
  'password1234',
  'password12345',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwerty123456',
  'iloveyou1234',
  'administrator',
  'welcome12345',
  'letmein12345',
  'changeme1234',
  'passw0rd1234',
  'p@ssw0rd1234',
  'abcdefghijkl',
  'abc123abc123',
]);

export type PasswordProblem = 'too_short' | 'too_long' | 'common' | 'same_as_email';

/** Returns a machine-readable reason, or null when the password is acceptable. Length is counted in characters, not bytes. */
export function passwordProblem(pw: string, email?: string): PasswordProblem | null {
  const n = [...pw].length;
  if (n < PASSWORD_MIN) return 'too_short';
  if (n > PASSWORD_MAX) return 'too_long';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/u.test(pw)) return 'common';
  if (email && low === email.trim().toLowerCase()) return 'same_as_email';
  return null;
}

/** A hash that never matches anything, verified against when the email is unknown so both paths cost the same. */
export async function makeDummyHash(cost: ScryptCost): Promise<string> {
  return hashPassword(randomBytes(18).toString('base64'), cost);
}
