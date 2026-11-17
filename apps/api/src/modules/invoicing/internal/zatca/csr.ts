import { sha256, type KeyVault } from './signing';

/**
 * A PKCS#10 certificate signing request, built with a small DER writer (no extra dependency). It carries the subject and the public key behind a
 * vault ref and is signed through the vault (ECDSA with SHA-256, secp256k1). The attributes and extensions ZATCA's compliance CSID request
 * requires (certificate template, subject alternative name with the registered address, ...) are NOT included: they cannot be pinned without the
 * official documents (HG-03-03). A CSR from this builder is a TEST artifact and cannot be sent to a ZATCA environment.
 */
const len = (n: number): Buffer =>
  n < 128
    ? Buffer.from([n])
    : n < 256
      ? Buffer.from([0x81, n])
      : Buffer.from([0x82, n >> 8, n & 255]);
const tlv = (tag: number, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  return Buffer.concat([Buffer.from([tag]), len(b.length), b]);
};
const oid = (s: string): Buffer => {
  const p = s.split('.').map(Number);
  const out: number[] = [p[0]! * 40 + p[1]!];
  for (const n of p.slice(2)) {
    const stack = [n & 127];
    for (let v = n >> 7; v > 0; v >>= 7) stack.unshift((v & 127) | 128);
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};
const OID = {
  cn: '2.5.4.3',
  serial: '2.5.4.5',
  c: '2.5.4.6',
  o: '2.5.4.10',
  ou: '2.5.4.11',
  ecdsaSha256: '1.2.840.10045.4.3.2',
};
const rdn = (type: string, value: string, printable = false) =>
  tlv(0x31, tlv(0x30, oid(type), tlv(printable ? 0x13 : 0x0c, Buffer.from(value, 'utf8'))));

export interface CsrSubject {
  commonName: string;
  organization: string;
  organizationalUnit?: string;
  country: string;
  serialNumber?: string;
}

export async function buildCsr(
  vault: KeyVault,
  keyRef: string,
  s: CsrSubject,
): Promise<{ der: Buffer; pem: string }> {
  if (!/^[A-Z]{2}$/.test(s.country)) throw new Error('country must be a two-letter code');
  for (const [k, v] of Object.entries(s))
    if (typeof v === 'string' && (v.length < 1 || v.length > 128))
      throw new Error(`${k} must be 1..128 characters`);
  const subject = tlv(
    0x30,
    rdn(OID.c, s.country, true),
    rdn(OID.o, s.organization),
    ...(s.organizationalUnit ? [rdn(OID.ou, s.organizationalUnit)] : []),
    ...(s.serialNumber ? [rdn(OID.serial, s.serialNumber)] : []),
    rdn(OID.cn, s.commonName),
  );
  const spki = await vault.publicKey(keyRef);
  const info = tlv(0x30, tlv(0x02, Buffer.from([0])), subject, spki, tlv(0xa0));
  const signature = await vault.sign(keyRef, sha256(info));
  const der = tlv(
    0x30,
    info,
    tlv(0x30, oid(OID.ecdsaSha256)),
    tlv(0x03, Buffer.from([0]), signature),
  );
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return {
    der,
    pem: `-----BEGIN CERTIFICATE REQUEST-----\n${b64.trimEnd()}\n-----END CERTIFICATE REQUEST-----\n`,
  };
}
