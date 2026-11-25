/** Provisioning network fields per provider (mirror of the API's `NETWORK_FIELDS`, which validates again). Pure, so it is tested without a browser. */
export const NETWORK_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  alibaba: { required: ['vSwitchId', 'securityGroupId'], optional: ['zoneId'] },
  huawei: {
    required: ['vpcId', 'subnetId', 'securityGroupId'],
    optional: ['availabilityZone', 'projectId'],
  },
};
export const NETWORK_PROVIDERS = Object.keys(NETWORK_FIELDS);

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;
const REGION = /^[a-z0-9][a-z0-9-]{1,40}$/;

export function networkBody(
  providerKey: string,
  region: string,
  values: Record<string, string>,
):
  | { ok: true; region: string; body: Record<string, string> }
  | { ok: false; error: 'region' | 'field' } {
  const spec = NETWORK_FIELDS[providerKey];
  const r = region.trim().toLowerCase();
  if (!spec || !REGION.test(r)) return { ok: false, error: 'region' };
  const body: Record<string, string> = {};
  for (const f of [...spec.required, ...spec.optional]) {
    const v = (values[f] ?? '').trim();
    if (v === '') {
      if (spec.required.includes(f)) return { ok: false, error: 'field' };
      continue;
    }
    if (!ID.test(v)) return { ok: false, error: 'field' };
    body[f] = v;
  }
  return { ok: true, region: r, body };
}
