import { createHash } from 'node:crypto';
import type { ZatcaProfile } from './profile';

/**
 * Document hash and the invoice chain (docs/11 §5): ICV (a counter per billing entity and environment) and PIH (the hash of the previous
 * document). The hash is SHA-256, base64, of the exact bytes of the BODY (the document without its QR and signature). The generator emits
 * the body in one fixed form (no insignificant whitespace, fixed attribute order, one escaping), so those bytes ARE the canonical form for this
 * synthetic profile; the official canonicalization (C14N) is NOT implemented and is NOT VERIFIED.
 */
export const sha256Base64 = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('base64');
export const sha256Hex = (data: Buffer | string): string =>
  createHash('sha256').update(data).digest('hex');
export const documentHash = (xmlBody: string): string => sha256Base64(Buffer.from(xmlBody, 'utf8'));

/** The PIH of the first document: base64 of the hex SHA-256 of the profile's seed. */
export const firstPih = (p: ZatcaProfile): string =>
  Buffer.from(sha256Hex(p.firstPihSeed), 'utf8').toString('base64');

export interface ChainLink {
  icv: bigint;
  pih: string;
  invoiceHash: string;
}
export interface ChainProblem {
  icv: bigint | null;
  problem: 'first_icv' | 'gap' | 'duplicate' | 'pih_mismatch' | 'first_pih' | 'hash_mismatch';
  detail: string;
}

/**
 * Verify a chain given in ICV order: the first icv is 1 with the profile's first PIH, every next icv is exactly +1, every pih equals the previous
 * hash. `recomputed` (optional) maps icv to the hash recomputed from the stored body: a difference means a body was altered after hashing.
 */
export function verifyChain(
  links: ChainLink[],
  p: ZatcaProfile,
  recomputed?: Map<bigint, string>,
): ChainProblem[] {
  const out: ChainProblem[] = [];
  let prev: ChainLink | null = null;
  for (const l of links) {
    if (!prev) {
      if (l.icv !== 1n)
        out.push({
          icv: l.icv,
          problem: 'first_icv',
          detail: `the chain starts at ${l.icv}, not 1`,
        });
      if (l.pih !== firstPih(p))
        out.push({
          icv: l.icv,
          problem: 'first_pih',
          detail: 'the first document does not carry the first PIH',
        });
    } else {
      if (l.icv === prev.icv)
        out.push({ icv: l.icv, problem: 'duplicate', detail: `icv ${l.icv} appears twice` });
      else if (l.icv !== prev.icv + 1n)
        out.push({ icv: l.icv, problem: 'gap', detail: `icv jumps from ${prev.icv} to ${l.icv}` });
      if (l.pih !== prev.invoiceHash)
        out.push({
          icv: l.icv,
          problem: 'pih_mismatch',
          detail: `pih of ${l.icv} is not the hash of ${prev.icv}`,
        });
    }
    const re = recomputed?.get(l.icv);
    if (re !== undefined && re !== l.invoiceHash)
      out.push({
        icv: l.icv,
        problem: 'hash_mismatch',
        detail: `the stored body of ${l.icv} no longer matches its hash`,
      });
    prev = l;
  }
  return out;
}
