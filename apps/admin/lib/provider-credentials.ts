/**
 * The key fields each compute vendor's adapter reads (mirror of the API's `credential-schema.ts`, which is the authority and validates again). `kinds` are the
 * complete sets an account may use: Huawei accepts an AK/SK pair OR an IAM user. Pure, so it is tested without a browser.
 */
export const CREDENTIAL_KINDS: Record<string, { id: string; fields: string[] }[]> = {
  alibaba: [{ id: 'keypair', fields: ['accessKeyId', 'accessKeySecret'] }],
  huawei: [
    { id: 'keypair', fields: ['accessKey', 'secretKey'] },
    { id: 'iam', fields: ['iamUser', 'iamPassword', 'domainName'] },
  ],
  contabo: [{ id: 'keypair', fields: ['clientId', 'clientSecret', 'apiUser', 'apiPassword'] }],
};
export const CREDENTIAL_PROVIDERS = Object.keys(CREDENTIAL_KINDS);

export const kindsOf = (providerKey: string) => CREDENTIAL_KINDS[providerKey] ?? [];

/** The `credentials` body of one kind, or null when a field is empty or has a character the API refuses. Values are trimmed. */
export function credentialsBody(
  providerKey: string,
  kindId: string,
  values: Record<string, string>,
): Record<string, string> | null {
  const kind = kindsOf(providerKey).find((k) => k.id === kindId);
  if (!kind) return null;
  const out: Record<string, string> = {};
  for (const f of kind.fields) {
    const v = (values[f] ?? '').trim();
    if (!/^[\x21-\x7E]{3,400}$/.test(v)) return null;
    out[f] = v;
  }
  return out;
}
