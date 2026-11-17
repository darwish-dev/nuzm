import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Signing (docs/11 §5, "key material ONLY as vault refs"). The signing service never returns, logs or exports a private key: callers hold a
 * REF (`vault://dev/zatca/<name>`) and ask the vault to sign a digest or to reveal the PUBLIC key. The vault choice is open (D-12): the only
 * implementation here is a development file vault for SELF-GENERATED TEST KEYS, refused in a production profile.
 * Algorithm: ECDSA over secp256k1 on a SHA-256 digest, DER signature. The official parameters are NOT VERIFIED.
 */
export const CURVE = 'secp256k1';
const REF = /^vault:\/\/dev\/zatca\/([a-z0-9][a-z0-9_-]{1,60})$/;

export interface KeyVault {
  /** Sign a 32-byte digest; returns the DER signature. */
  sign(ref: string, digest: Buffer): Promise<Buffer>;
  /** The public key as DER SubjectPublicKeyInfo. */
  publicKey(ref: string): Promise<Buffer>;
  exists(ref: string): Promise<boolean>;
}

export class DevFileVault implements KeyVault {
  private readonly dir: string;
  constructor(
    dir = process.env.ZATCA_DEV_VAULT_DIR ?? '.local/zatca-vault',
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (env.NODE_ENV === 'production')
      throw new Error(
        'the development key vault is refused in a production profile (the vault choice is D-12)',
      );
    this.dir = resolve(dir);
  }
  private path(ref: string): string {
    const m = REF.exec(ref);
    if (!m) throw new Error('not a zatca vault reference');
    return join(this.dir, `${m[1]}.pem`);
  }
  async exists(ref: string): Promise<boolean> {
    return existsSync(this.path(ref));
  }
  /** Create a self-generated TEST key for a ref (development/sandbox only). Refuses to overwrite. */
  async generateTestKey(ref: string): Promise<void> {
    const p = this.path(ref);
    if (existsSync(p)) throw new Error('a key already exists for this reference');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: CURVE });
    writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      mode: 0o600,
      flag: 'wx',
    });
  }
  private key(ref: string) {
    return createPrivateKey(readFileSync(this.path(ref)));
  }
  async sign(ref: string, digest: Buffer): Promise<Buffer> {
    if (digest.length !== 32) throw new Error('sign expects a 32-byte SHA-256 digest');
    return nodeSign(null, digest, { key: this.key(ref), dsaEncoding: 'der' });
  }
  async publicKey(ref: string): Promise<Buffer> {
    return createPublicKey(this.key(ref)).export({ type: 'spki', format: 'der' });
  }
}

/** Verify a DER signature over a digest with a DER SPKI public key. */
export function verifySignature(spkiDer: Buffer, digest: Buffer, signatureDer: Buffer): boolean {
  return nodeVerify(
    null,
    digest,
    { key: createPublicKey({ key: spkiDer, format: 'der', type: 'spki' }), dsaEncoding: 'der' },
    signatureDer,
  );
}

/** Sign the base64 document hash with the key behind `ref`: the digest signed is the hash bytes themselves. */
export async function signDocumentHash(
  vault: KeyVault,
  ref: string,
  documentHashBase64: string,
): Promise<{ signature: string; publicKey: string }> {
  const digest = Buffer.from(documentHashBase64, 'base64');
  if (digest.length !== 32) throw new Error('a document hash is 32 bytes (SHA-256)');
  const [sig, pub] = await Promise.all([vault.sign(ref, digest), vault.publicKey(ref)]);
  return { signature: sig.toString('base64'), publicKey: pub.toString('base64') };
}
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
