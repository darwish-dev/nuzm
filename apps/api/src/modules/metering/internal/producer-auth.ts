import { createHash, timingSafeEqual } from 'node:crypto';

export interface ProducerKey {
  /** `module@Mnn`: the ONLY source name this key may report as (the request body can never choose it). */
  source: string;
  /** SHA-256 hex of the key. Keys are never stored in the clear. */
  sha256: string;
  /** Organizations this key may report for; null = any organization (platform producers). */
  orgIds: string[] | null;
}
export interface Producer {
  source: string;
  orgIds: string[] | null;
}

const SOURCE = /^[a-z][a-z0-9_-]*@M[0-9]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-source service credentials for the internal metering endpoint (node agents, sandbox runners). DEV/CONFIG stand-in
 * until the vault is chosen (D-12): `METERING_SOURCE_KEYS` is a JSON array of {source, sha256, orgIds?}. With no
 * configuration the endpoint is unavailable (fail closed). mTLS terminates at the ingress (documented in the runbook).
 */
export function loadProducerKeys(env: NodeJS.ProcessEnv = process.env): ProducerKey[] {
  const raw = env.METERING_SOURCE_KEYS;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('METERING_SOURCE_KEYS must be valid JSON');
  }
  if (!Array.isArray(parsed)) throw new Error('METERING_SOURCE_KEYS must be an array');
  return parsed.map((k, i) => {
    const o = k as { source?: unknown; sha256?: unknown; orgIds?: unknown };
    if (typeof o.source !== 'string' || !SOURCE.test(o.source))
      throw new Error(`METERING_SOURCE_KEYS[${i}].source must look like module@Mnn`);
    if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256))
      throw new Error(`METERING_SOURCE_KEYS[${i}].sha256 must be 64 hex chars`);
    if (
      o.orgIds !== undefined &&
      (!Array.isArray(o.orgIds) || !o.orgIds.every((x) => typeof x === 'string' && UUID.test(x)))
    )
      throw new Error(`METERING_SOURCE_KEYS[${i}].orgIds must be UUIDs`);
    return {
      source: o.source,
      sha256: o.sha256,
      orgIds: o.orgIds === undefined ? null : (o.orgIds as string[]).map((x) => x.toLowerCase()),
    };
  });
}

export class ProducerAuthenticator {
  constructor(private readonly keys: ProducerKey[]) {}

  get configured(): boolean {
    return this.keys.length > 0;
  }

  /** Constant-time match of the presented key against every configured key. */
  authenticate(presented: string | undefined): Producer | null {
    if (!presented || presented.length > 256) return null;
    const digest = createHash('sha256').update(presented).digest();
    let hit: ProducerKey | null = null;
    for (const k of this.keys) {
      const ok = timingSafeEqual(digest, Buffer.from(k.sha256, 'hex'));
      if (ok && !hit) hit = k;
    }
    return hit ? { source: hit.source, orgIds: hit.orgIds } : null;
  }
}
