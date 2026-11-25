import { ProblemException } from '../../../common/errors';

/**
 * The credential fields each compute vendor's adapter reads from its vault entry (the adapters are the source: `material.fields.*` in alibaba-ecs, huawei-ecs and
 * contabo-vps). `alternatives` are the complete sets an account may use (Huawei accepts an AK/SK pair OR an IAM user). Nothing else is accepted, stored or kept.
 */
export interface CredentialSpec {
  alternatives: string[][];
}
export const CREDENTIAL_SPECS: Record<string, CredentialSpec> = {
  alibaba: { alternatives: [['accessKeyId', 'accessKeySecret']] },
  huawei: {
    alternatives: [
      ['accessKey', 'secretKey'],
      ['iamUser', 'iamPassword', 'domainName'],
    ],
  },
  contabo: { alternatives: [['clientId', 'clientSecret', 'apiUser', 'apiPassword']] },
};

const VALUE = /^[\x21-\x7E]{3,400}$/;
const reject = (m: string) => new ProblemException('validation_failed', m);

/** Validates typed credentials for a provider and returns the trimmed field set. Never echoes a value in an error. */
export function parseCredentials(providerKey: string, input: unknown): Record<string, string> {
  const spec = CREDENTIAL_SPECS[providerKey];
  if (!spec)
    throw new ProblemException(
      'unsupported_capability',
      `credentials cannot be entered here for provider ${providerKey}: use a vault reference (credentialRef)`,
    );
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw reject('credentials must be an object of named fields');
  const known = new Set(spec.alternatives.flat());
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!known.has(k)) throw reject(`unknown credential field ${k} for ${providerKey}`);
    if (typeof v !== 'string' || !VALUE.test(v.trim()))
      throw reject(`${k} must be 3 to 400 printable characters with no spaces`);
    out[k] = v.trim();
  }
  if (!spec.alternatives.some((alt) => alt.every((f) => out[f] !== undefined)))
    throw reject(
      `${providerKey} needs ${spec.alternatives.map((a) => a.join(' + ')).join(' or ')}`,
    );
  // a half-filled second alternative is a mistake, not a choice: keep only the complete set(s)
  const complete = spec.alternatives.filter((alt) => alt.every((f) => out[f] !== undefined));
  const keep = new Set(complete.flat());
  for (const k of Object.keys(out)) if (!keep.has(k)) delete out[k];
  return out;
}
