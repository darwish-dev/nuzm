/**
 * QR payload as TLV (tag, length, value), base64 (docs/11 §5). Synthetic tag set from the profile; the official tag list, the optional tag 9
 * (certificate signature) and the size rules are NOT VERIFIED. A value longer than 255 bytes is refused (one length byte).
 */
export interface TlvField {
  tag: number;
  value: Buffer;
}
export function encodeTlv(fields: TlvField[]): string {
  const parts: Buffer[] = [];
  for (const f of fields) {
    if (!Number.isInteger(f.tag) || f.tag < 1 || f.tag > 255)
      throw new Error(`invalid TLV tag ${f.tag}`);
    if (f.value.length > 255) throw new Error(`TLV value of tag ${f.tag} is longer than 255 bytes`);
    parts.push(Buffer.from([f.tag, f.value.length]), f.value);
  }
  return Buffer.concat(parts).toString('base64');
}
export function decodeTlv(b64: string): TlvField[] {
  const buf = Buffer.from(b64, 'base64');
  const out: TlvField[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 2 > buf.length) throw new Error('truncated TLV');
    const tag = buf[i]!;
    const len = buf[i + 1]!;
    if (i + 2 + len > buf.length) throw new Error('truncated TLV value');
    out.push({ tag, value: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}
