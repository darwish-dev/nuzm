import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';

/**
 * Provisioning network details per provider and region (what a vendor needs to place a server in the owner's own cloud account): Alibaba vSwitch + security group, Huawei
 * VPC + subnet + security group + project id. Resource IDENTIFIERS, never credentials. The console writes them; the adapters read them through the in-memory cache, which a save
 * refreshes at once (and a periodic reload refreshes for other processes). A region without a row is "not configured": the adapter refuses, it never guesses.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,99}$/;
const REGION = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const NETWORK_FIELDS: Record<string, { required: string[]; optional: string[] }> = {
  alibaba: { required: ['vSwitchId', 'securityGroupId'], optional: ['zoneId'] },
  huawei: {
    required: ['vpcId', 'subnetId', 'securityGroupId'],
    optional: ['availabilityZone', 'projectId'],
  },
};

export interface NetworkSettingDto {
  providerKey: string;
  regionId: string;
  settings: Record<string, string>;
  updatedAt: string;
}

export class NetworkSettingsService {
  private cache = new Map<string, Record<string, string>>();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
  ) {}

  /** The settings of one region, or undefined. Synchronous: the adapters call it on the provisioning path. */
  get(providerKey: string, region: string): Record<string, string> | undefined {
    return this.cache.get(`${providerKey}|${region}`);
  }

  async refresh(): Promise<void> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT provider_key, region_id, settings FROM cloud.provider_network_settings`,
          )
        ).rows,
    );
    this.cache = new Map(
      rows.map((r) => [`${r.provider_key}|${r.region_id}`, r.settings as Record<string, string>]),
    );
  }

  async list(): Promise<NetworkSettingDto[]> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT provider_key, region_id, settings, updated_at FROM cloud.provider_network_settings ORDER BY provider_key, region_id`,
          )
        ).rows,
    );
    return rows.map((r) => ({
      providerKey: r.provider_key as string,
      regionId: r.region_id as string,
      settings: r.settings as Record<string, string>,
      updatedAt: (r.updated_at as Date).toISOString(),
    }));
  }

  private check(providerKey: string, regionId: string) {
    const spec = NETWORK_FIELDS[providerKey];
    if (!spec) throw new ProblemException('not_found', 'this provider has no network settings');
    if (!REGION.test(regionId))
      throw new ProblemException('validation_failed', 'regionId must be a provider region id');
    return spec;
  }

  async save(
    actorUserId: string,
    providerKey: string,
    regionId: string,
    input: unknown,
  ): Promise<NetworkSettingDto> {
    const spec = this.check(providerKey, regionId);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ProblemException('validation_failed', 'the body must be an object');
    const b = input as Record<string, unknown>;
    const known = new Set([...spec.required, ...spec.optional]);
    const settings: Record<string, string> = {};
    for (const [k, v] of Object.entries(b)) {
      if (!known.has(k)) throw new ProblemException('validation_failed', `unknown field ${k}`);
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || !ID.test(v.trim()))
        throw new ProblemException(
          'validation_failed',
          `${k} must be a resource id (3 to 100 letters, digits, . _ -)`,
        );
      settings[k] = v.trim();
    }
    for (const k of spec.required)
      if (!settings[k]) throw new ProblemException('validation_failed', `${k} is required`);
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO cloud.provider_network_settings (provider_key, region_id, settings, updated_by) VALUES ($1,$2,$3::jsonb,$4)
         ON CONFLICT (provider_key, region_id) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [providerKey, regionId, JSON.stringify(settings), actorUserId],
      );
      await this.audit.record({
        action: 'provider.network_settings.saved',
        actorUserId,
        resource: { type: 'provider_network', id: `${providerKey}/${regionId}` },
        outcome: 'success',
        after: { fields: Object.keys(settings) },
      });
    });
    await this.refresh();
    return (await this.list()).find(
      (x) => x.providerKey === providerKey && x.regionId === regionId,
    )!;
  }

  async remove(actorUserId: string, providerKey: string, regionId: string): Promise<void> {
    this.check(providerKey, regionId);
    const n = await this.db.withPlatformScope(async (c) => {
      const r = await c.query(
        `DELETE FROM cloud.provider_network_settings WHERE provider_key = $1 AND region_id = $2`,
        [providerKey, regionId],
      );
      if (r.rowCount)
        await this.audit.record({
          action: 'provider.network_settings.removed',
          actorUserId,
          resource: { type: 'provider_network', id: `${providerKey}/${regionId}` },
          outcome: 'success',
        });
      return r.rowCount ?? 0;
    });
    if (!n) throw new ProblemException('not_found');
    await this.refresh();
  }
}
