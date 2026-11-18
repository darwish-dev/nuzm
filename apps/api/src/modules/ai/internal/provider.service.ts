import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { AI_KILLSWITCH, isUuid, type AiConfig, type Row } from './model';
import type { ModelAdapterRegistry } from './registry';

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;
const INT = /^\d{1,15}$/;
const dev = (code: string) => /^(mock|local)-/.test(code);

export interface RateCardModels {
  models: Record<string, { creditsPerMillionInput: string; creditsPerMillionOutput: string }>;
}
export interface ProviderDto {
  id: string;
  code: string;
  adapter: string;
  displayName: string;
  region: string;
  dataTerms: {
    attested: boolean;
    retainsPrompts: boolean | 'unknown';
    trainsOnData: boolean | 'unknown';
    processingRegion?: string;
  };
  attestationRef: string | null;
  vaultRef: string | null;
  rateCardVersion: string;
  rateCard: RateCardModels;
  enabled: boolean;
  enableRequestedBy: string | null;
  enabledBy: string | null;
  adapterRegistered: boolean;
  version: number;
}

/**
 * The registry of model providers (docs/09 §7; D-18 OPEN). Nothing is seeded and nothing is hardcoded. Enabling follows the rules the table CHECKs repeat:
 * (1) the data terms are ATTESTED by a human with a reference (HG-09-01) — an unattested provider can never be enabled; (2) the adapter is registered;
 * (3) a SECOND person enables (two-person rule) except the dev-reference `mock-*`/`local-*` providers, which exist only outside production.
 */
export class ModelProviderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly registry: ModelAdapterRegistry,
    private readonly cfg: AiConfig,
  ) {}

  private dto(r: Row): ProviderDto {
    return {
      id: r.id as string,
      code: r.code as string,
      adapter: r.adapter as string,
      displayName: r.display_name as string,
      region: r.region as string,
      dataTerms: r.data_terms as ProviderDto['dataTerms'],
      attestationRef: (r.attestation_ref as string | null) ?? null,
      vaultRef: (r.vault_ref as string | null) ?? null,
      rateCardVersion: r.rate_card_version as string,
      rateCard: r.rate_card as RateCardModels,
      enabled: r.enabled as boolean,
      enableRequestedBy: (r.enable_requested_by as string | null) ?? null,
      enabledBy: (r.enabled_by as string | null) ?? null,
      adapterRegistered: this.registry.get(r.code as string) !== undefined,
      version: r.version as number,
    };
  }
  async list(): Promise<{ items: ProviderDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM ai.model_providers ORDER BY code`)).rows as Row[],
    );
    return { items: rows.map((r) => this.dto(r)) };
  }
  private async load(id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('validation_failed', 'id must be a uuid');
    const r = (await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM ai.model_providers WHERE id=$1`, [id])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }
  /** Enabled providers whose adapter is registered: what the gateway may route to. */
  async enabledWithAdapters(): Promise<{ row: ProviderDto }[]> {
    const rows = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM ai.model_providers WHERE enabled`)).rows as Row[],
    );
    return rows.map((r) => ({ row: this.dto(r) })).filter((x) => x.row.adapterRegistered);
  }

  static parseRateCard(v: unknown): RateCardModels {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      throw new ProblemException(
        'validation_failed',
        'rateCard must be {models:{<modelId>:{creditsPerMillionInput,creditsPerMillionOutput}}}',
      );
    const models = (v as { models?: unknown }).models;
    if (typeof models !== 'object' || models === null || Array.isArray(models))
      throw new ProblemException('validation_failed', 'rateCard.models must be an object');
    const out: RateCardModels['models'] = {};
    for (const [id, m] of Object.entries(models)) {
      const x = m as { creditsPerMillionInput?: unknown; creditsPerMillionOutput?: unknown };
      if (
        !/^[A-Za-z0-9._:/-]{1,80}$/.test(id) ||
        typeof x?.creditsPerMillionInput !== 'string' ||
        !INT.test(x.creditsPerMillionInput) ||
        typeof x.creditsPerMillionOutput !== 'string' ||
        !INT.test(x.creditsPerMillionOutput)
      )
        throw new ProblemException(
          'validation_failed',
          `rateCard.models.${id.slice(0, 40)}: credits per million tokens must be integer strings`,
        );
      out[id] = {
        creditsPerMillionInput: x.creditsPerMillionInput,
        creditsPerMillionOutput: x.creditsPerMillionOutput,
      };
    }
    return { models: out };
  }

  /** Create or update the configuration. A change of region or rate card DISABLES the provider and drops the attestation of the region it no longer matches. */
  async configure(actor: string, b: Record<string, unknown>): Promise<ProviderDto> {
    const code = b.code;
    if (typeof code !== 'string' || !SLUG.test(code))
      throw new ProblemException('validation_failed', 'code must be a lower-case slug');
    if (dev(code) && (this.cfg.localReference === false || process.env.NODE_ENV === 'production'))
      throw new ProblemException(
        'validation_failed',
        'dev-reference providers (mock-*, local-*) exist only with AI_LOCAL_REFERENCE outside production',
      );
    const adapter = typeof b.adapter === 'string' && SLUG.test(b.adapter) ? b.adapter : null;
    if (!adapter)
      throw new ProblemException('validation_failed', 'adapter must be a lower-case slug');
    const displayName =
      typeof b.displayName === 'string' && b.displayName.length >= 1 && b.displayName.length <= 100
        ? b.displayName
        : null;
    if (!displayName)
      throw new ProblemException('validation_failed', 'displayName must be 1..100 characters');
    const region =
      typeof b.region === 'string' && b.region.length >= 2 && b.region.length <= 64
        ? b.region
        : null;
    if (!region)
      throw new ProblemException('validation_failed', 'region must be a country code or region id');
    const vaultRef = b.vaultRef ?? null;
    if (
      vaultRef !== null &&
      (typeof vaultRef !== 'string' ||
        !/^vault:\/\/[A-Za-z0-9][A-Za-z0-9._/-]{1,200}$/.test(vaultRef))
    )
      throw new ProblemException(
        'validation_failed',
        'vaultRef must be a vault:// reference (credential values are never accepted)',
      );
    for (const k of Object.keys(b))
      if (/(secret|password|api_?key|token|private)/i.test(k))
        throw new ProblemException(
          'credential_value_rejected',
          `${k}: send a vault reference as vaultRef`,
        );
    const rateCard = ModelProviderService.parseRateCard(b.rateCard ?? { models: {} });
    const egress = Array.isArray(b.egressAllow)
      ? b.egressAllow.filter(
          (h): h is string => typeof h === 'string' && /^[a-z0-9.-]{3,200}$/.test(h),
        )
      : [];
    const rateCardVersion =
      typeof b.rateCardVersion === 'string' && b.rateCardVersion.length <= 40
        ? b.rateCardVersion
        : '1';
    const row = await this.db.withPlatformScope(async (c) => {
      const cur = (
        await c.query(`SELECT * FROM ai.model_providers WHERE code=$1 FOR UPDATE`, [code])
      ).rows[0] as Row | undefined;
      if (!cur) {
        return (
          await c.query(
            `INSERT INTO ai.model_providers (id, code, adapter, display_name, region, vault_ref, egress_allow, rate_card_version, rate_card, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [
              uuidv7(),
              code,
              adapter,
              displayName,
              region,
              vaultRef,
              JSON.stringify(egress),
              rateCardVersion,
              JSON.stringify(rateCard),
              actor,
            ],
          )
        ).rows[0] as Row;
      }
      const regionChanged = cur.region !== region;
      return (
        await c.query(
          `UPDATE ai.model_providers SET adapter=$2, display_name=$3, region=$4, vault_ref=$5, egress_allow=$6, rate_card_version=$7, rate_card=$8,
                  enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL,
                  data_terms = CASE WHEN $9 THEN '{"attested":false,"retainsPrompts":"unknown","trainsOnData":"unknown"}'::jsonb ELSE data_terms END,
                  attestation_ref = CASE WHEN $9 THEN NULL ELSE attestation_ref END, attested_by = CASE WHEN $9 THEN NULL ELSE attested_by END, attested_at = CASE WHEN $9 THEN NULL ELSE attested_at END,
                  updated_at=now(), version=version+1 WHERE code=$1 RETURNING *`,
          [
            code,
            adapter,
            displayName,
            region,
            vaultRef,
            JSON.stringify(egress),
            rateCardVersion,
            JSON.stringify(rateCard),
            regionChanged,
          ],
        )
      ).rows[0] as Row;
    });
    await this.audit.record({
      action: 'ai.provider.configured',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id: row.id as string },
      outcome: 'success',
      detail: { code, region },
    });
    return this.dto(row);
  }

  /** Record the human attestation of the contractual data terms (HG-09-01). The reference points at the signed attestation in docs/07. */
  async attest(actor: string, id: string, b: Record<string, unknown>): Promise<ProviderDto> {
    const cur = await this.load(id);
    const t = (b.dataTerms ?? {}) as Record<string, unknown>;
    const flag = (v: unknown) => (v === true || v === false || v === 'unknown' ? v : null);
    const retains = flag(t.retainsPrompts);
    const trains = flag(t.trainsOnData);
    const ref = b.attestationRef;
    if (retains === null || trains === null)
      throw new ProblemException(
        'validation_failed',
        'dataTerms.retainsPrompts and trainsOnData must be true, false or "unknown"',
      );
    if (typeof ref !== 'string' || ref.length < 3 || ref.length > 200)
      throw new ProblemException(
        'validation_failed',
        'attestationRef (the signed attestation reference) is required',
      );
    const terms = {
      attested: true,
      retainsPrompts: retains,
      trainsOnData: trains,
      processingRegion: cur.region as string,
    };
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET data_terms=$2, attestation_ref=$3, attested_by=$4, attested_at=now(), enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id, JSON.stringify(terms), ref, actor],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.attested',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: row.code, retainsPrompts: retains, trainsOnData: trains },
    });
    return this.dto(row);
  }

  async requestEnable(actor: string, id: string): Promise<ProviderDto> {
    const r = await this.load(id);
    this.assertEnableable(r);
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET enable_requested_by=$2, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id, actor],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.enable_requested',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: r.code },
    });
    return this.dto(row);
  }
  private assertEnableable(r: Row) {
    const code = r.code as string;
    if (!this.registry.get(code))
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is registered for this provider',
      );
    if (Object.keys((r.rate_card as RateCardModels).models).length === 0)
      throw new ProblemException(
        'validation_failed',
        'a rate card with at least one model is required',
      );
    if (dev(code)) return;
    const terms = r.data_terms as { attested?: boolean };
    if (terms.attested !== true || !r.attestation_ref)
      throw new ProblemException(
        'unsupported_capability',
        'the data terms are not attested by a human (HG-09-01): a provider cannot be enabled',
      );
  }
  async enable(actor: string, id: string): Promise<ProviderDto> {
    const r = await this.load(id);
    this.assertEnableable(r);
    const isDev = dev(r.code as string);
    if (!isDev) {
      if (!r.enable_requested_by)
        throw new ProblemException('invalid_state', 'enabling must be requested first');
      if (r.enable_requested_by === actor)
        throw new ProblemException(
          'forbidden',
          'a second person must approve enabling (two-person rule)',
        );
    }
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET enabled=true, enabled_at=now(), enabled_by=$2, enable_requested_by = coalesce(enable_requested_by, $3), updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id, actor, isDev ? '00000000-0000-0000-0000-000000000000' : r.enable_requested_by],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.enabled',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: r.code, region: r.region },
    });
    return this.dto(row);
  }
  async disable(actor: string, id: string): Promise<ProviderDto> {
    const r = await this.load(id);
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.disabled',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: r.code },
    });
    return this.dto(row);
  }

  /** Global (orgId omitted) or per-organization kill switch. Effective on the very next call (the gateway reads it uncached). */
  async setKillSwitch(
    actor: string,
    on: boolean,
    orgId?: string,
  ): Promise<{ killSwitch: boolean; scope: 'global' | 'org' }> {
    if (orgId !== undefined && !isUuid(orgId))
      throw new ProblemException('validation_failed', 'orgId must be a uuid');
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO platform.feature_flags (id, key, org_id, value, updated_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [uuidv7(), AI_KILLSWITCH, orgId ?? null, JSON.stringify(on), actor],
      );
    });
    await this.audit.record({
      action: 'ai.killswitch.toggled',
      actorUserId: actor,
      actorType: 'user',
      ...(orgId ? { orgId } : {}),
      resource: { type: 'ai_killswitch' },
      outcome: 'success',
      detail: { on, scope: orgId ? 'org' : 'global' },
    });
    return { killSwitch: on, scope: orgId ? 'org' : 'global' };
  }
}
