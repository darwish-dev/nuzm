import { v7 as uuidv7 } from 'uuid';
import {
  ProbeRefused,
  contractAtLeast,
  probeWorstCase,
  runCapabilityProbe,
} from '@nuzm/adapter-model';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { SecretStore } from '../../../common/secrets';
import { ProblemException } from '../../../common/errors';
import { AI_KILLSWITCH, isUuid, type AiConfig, type Row } from './model';
import type { ModelAdapterRegistry } from './registry';
import type { ConnectionProbe, ProbeResult } from './claude-probe';

const SLUG = /^[a-z][a-z0-9-]{1,40}$/;
const INT = /^\d{1,15}$/;
const dev = (code: string) => /^(mock|local)-/.test(code);
/** The capabilities of contract 1.1 that need recorded evidence for a real provider (S-AG4b, D8). */
export const EVIDENCE_CAPABILITIES = [
  'tool-use',
  'streaming-tool-calls',
  'parallel-tool-calls',
] as const;
export type EvidenceCapability = (typeof EVIDENCE_CAPABILITIES)[number];
const isEvidenceCapability = (v: unknown): v is EvidenceCapability =>
  (EVIDENCE_CAPABILITIES as readonly unknown[]).includes(v);
export interface EvidenceDto {
  model: string;
  capability: EvidenceCapability;
  state: 'VERIFIED' | 'NOT VERIFIED';
  evidenceRef: string;
  contractVersion: string;
  recordedBy: string;
  recordedAt: string;
}

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
  /** the contract the registered adapter implements; null without an adapter */
  contractVersion: string | null;
  /** this environment lists the provider as approved for live calls (AI_LIVE_PROVIDERS) */
  liveCallsApproved: boolean;
  /** the LATEST recorded state per model and tool-calling capability (history stays in the table) */
  capabilityEvidence: EvidenceDto[];
  version: number;
}

/**
 * The registry of model providers (docs/09 §7; D-18 OPEN). Nothing is seeded and nothing is hardcoded. Enabling follows the rules the table CHECKs repeat:
 * (1) the data terms are ATTESTED by a human with a reference (HG-09-01) — an unattested provider can never be enabled; (2) the adapter is registered;
 * (3) a SECOND person enables (two-person rule) except the dev-reference `mock-*`/`local-*` providers, which exist only outside production.
 */
/** An API key as providers issue them: printable ASCII, no spaces, a sensible length. The value is never echoed in an error. */
const CLAUDE_CODE = 'claude';
const API_KEY = /^[\x21-\x7E]{20,400}$/;

export class ModelProviderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly registry: ModelAdapterRegistry,
    private readonly cfg: AiConfig,
    /** Where an API key typed in the admin console is kept (sealed). Absent in a profile with no secret store: the key actions then say so. */
    private readonly secrets?: SecretStore,
    /** Asks the provider whether it accepts a key (a LIVE call). Absent where no probe is wired: the test then says it is unavailable. */
    private readonly probe?: ConnectionProbe,
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
      contractVersion: this.registry.get(r.code as string)?.contractVersion ?? null,
      liveCallsApproved: this.cfg.liveProviders?.includes(r.code as string) ?? false,
      capabilityEvidence: [],
      version: r.version as number,
    };
  }

  /** The latest evidence row per (provider, model, capability), for the given providers. Tolerant of anything that is not an evidence row. */
  private async latestEvidence(ids: string[]): Promise<Map<string, EvidenceDto[]>> {
    const out = new Map<string, EvidenceDto[]>();
    if (ids.length === 0) return out;
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT ON (provider_id, model_id, capability) *
               FROM ai.model_capability_evidence WHERE provider_id = ANY($1::uuid[])
              ORDER BY provider_id, model_id, capability, recorded_at DESC, id DESC`,
            [ids],
          )
        ).rows as Row[],
    );
    for (const e of rows) {
      if (
        !isEvidenceCapability(e.capability) ||
        (e.state !== 'VERIFIED' && e.state !== 'NOT VERIFIED')
      )
        continue;
      const list = out.get(e.provider_id as string) ?? [];
      list.push({
        model: e.model_id as string,
        capability: e.capability,
        state: e.state,
        evidenceRef: e.evidence_ref as string,
        contractVersion: e.contract_version as string,
        recordedBy: e.recorded_by as string,
        recordedAt:
          e.recorded_at instanceof Date ? e.recorded_at.toISOString() : String(e.recorded_at),
      });
      out.set(e.provider_id as string, list);
    }
    return out;
  }

  /** A provider as the admin API shows it: its facts plus the latest capability evidence. */
  private async view(r: Row): Promise<ProviderDto> {
    const ev = await this.latestEvidence([r.id as string]);
    return { ...this.dto(r), capabilityEvidence: ev.get(r.id as string) ?? [] };
  }

  /**
   * What the gateway may rely on (D8): `provider|model|capability` -> the contract version the evidence was recorded for, for every capability whose LATEST row is VERIFIED.
   * A dependent capability (streaming, parallel) only counts while tool-use is verified for the same contract. No row = no declaration.
   */
  async verifiedCapabilities(): Promise<Map<string, string>> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT DISTINCT ON (provider_id, model_id, capability) provider_id, model_id, capability, state, contract_version
               FROM ai.model_capability_evidence
              ORDER BY provider_id, model_id, capability, recorded_at DESC, id DESC`,
          )
        ).rows as Row[],
    );
    const ok = new Map<string, string>();
    for (const e of rows)
      if (e.state === 'VERIFIED' && isEvidenceCapability(e.capability))
        ok.set(
          `${e.provider_id as string}|${e.model_id as string}|${e.capability}`,
          e.contract_version as string,
        );
    for (const [k, v] of [...ok])
      if (!k.endsWith('|tool-use') && ok.get(`${k.slice(0, k.lastIndexOf('|'))}|tool-use`) !== v)
        ok.delete(k);
    return ok;
  }
  async list(): Promise<{ items: ProviderDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM ai.model_providers ORDER BY code`)).rows as Row[],
    );
    const ev = await this.latestEvidence(rows.map((r) => r.id as string));
    return {
      items: rows.map((r) => ({
        ...this.dto(r),
        capabilityEvidence: ev.get(r.id as string) ?? [],
      })),
    };
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
          `UPDATE ai.model_providers SET adapter=$2, display_name=$3, region=$4, vault_ref=COALESCE($5, vault_ref), egress_allow=$6, rate_card_version=$7, rate_card=$8,
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
    return this.view(row);
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
    return this.view(row);
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
    return this.view(row);
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
    return this.view(row);
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
    return this.view(row);
  }

  /**
   * Stores a provider's API key (typed by an administrator in the console) in the SEALED secret store and points the provider at its `vault://` reference.
   * The key is never written to the database, a log, an audit event or any response: only the reference is kept. A new credential is a configuration change,
   * so the provider is disabled and goes through the attest / request / enable steps again. Not available in production: the production vault is BLOCKED (D-12).
   */
  async setCredential(actor: string, id: string, apiKey: unknown): Promise<ProviderDto> {
    if (!this.secrets || process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'storing a key here is not available in this profile: the production vault is not decided yet (D-12); use a vault reference',
      );
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (!API_KEY.test(key))
      throw new ProblemException(
        'validation_failed',
        'the key must be 20 to 400 printable characters with no spaces',
      );
    const r = await this.load(id);
    const ref = await this.secrets.put(`ai-${r.code as string}`, key);
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET vault_ref=$2, enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id, ref],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.credential_set',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: r.code, vaultRef: ref },
    });
    return this.view(row);
  }

  /**
   * One-field setup for Claude: makes sure a provider named `claude` exists (created UNATTESTED and DISABLED, region not stated: that is a human
   * decision, HG-09-01), then stores the typed key exactly like `setCredential`. Nothing about the key is read back or logged. The provider cannot
   * be enabled until its data terms are attested and an adapter for it is registered; saving a key never changes that.
   */
  async saveClaudeKey(actor: string, apiKey: unknown): Promise<ProviderDto> {
    if (!this.secrets || process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'storing a key here is not available in this profile: the production vault is not decided yet (D-12); use a vault reference',
      );
    if (typeof apiKey !== 'string' || !API_KEY.test(apiKey.trim()))
      throw new ProblemException(
        'validation_failed',
        'the key must be 20 to 400 printable characters with no spaces',
      );
    const found = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT id FROM ai.model_providers WHERE code=$1`, [CLAUDE_CODE]))
          .rows[0] as { id: string } | undefined,
    );
    const id =
      found?.id ??
      (
        await this.configure(actor, {
          code: CLAUDE_CODE,
          adapter: 'anthropic',
          displayName: 'Claude',
          region: 'unspecified',
        })
      ).id;
    return this.setCredential(actor, id, apiKey);
  }

  /**
   * Records what a probe showed (D8, SCR-K-11 item 3): one append-only row per (model, capability). `VERIFIED` is accepted only for a capability the registered adapter declares
   * as a candidate under contract >= 1.1, and a dependent capability (streaming, parallel) only while tool-use is verified for the same contract. The row carries the contract
   * version of the adapter that was probed: a different adapter build no longer counts. Needs `admin:ai:approve` (checked by the controller); audited; changes nothing else.
   */
  async recordCapabilityEvidence(
    actor: string,
    id: string,
    b: Record<string, unknown>,
  ): Promise<ProviderDto> {
    const r = await this.load(id);
    const adapter = this.registry.get(r.code as string);
    if (!adapter)
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is registered for this provider',
      );
    const model = typeof b.model === 'string' ? b.model : '';
    const info = adapter.models().find((m) => m.modelId === model);
    if (!info)
      throw new ProblemException('validation_failed', "model must be one of the adapter's models");
    if (!isEvidenceCapability(b.capability))
      throw new ProblemException(
        'validation_failed',
        'capability must be tool-use, streaming-tool-calls or parallel-tool-calls',
      );
    const capability = b.capability;
    if (b.state !== 'VERIFIED' && b.state !== 'NOT VERIFIED')
      throw new ProblemException('validation_failed', 'state must be VERIFIED or NOT VERIFIED');
    const state = b.state;
    const ref = b.evidenceRef;
    if (typeof ref !== 'string' || ref.trim().length < 3 || ref.length > 200)
      throw new ProblemException(
        'validation_failed',
        'evidenceRef (a reference to the stored probe report) is required, 3 to 200 characters',
      );
    if (state === 'VERIFIED') {
      if (!contractAtLeast(adapter.contractVersion, '1.1.0'))
        throw new ProblemException(
          'unsupported_capability',
          'the adapter implements contract 1.0: nothing can be verified for it',
        );
      if (!info.capabilities.includes(capability))
        throw new ProblemException(
          'unsupported_capability',
          'the adapter does not declare this capability for this model (nothing to verify)',
        );
      if (capability !== 'tool-use') {
        const ok = (await this.verifiedCapabilities()).get(`${id}|${model}|tool-use`);
        if (ok !== adapter.contractVersion)
          throw new ProblemException(
            'invalid_state',
            'tool-use must be verified first for the contract version of the adapter',
          );
      }
    }
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `INSERT INTO ai.model_capability_evidence (id, provider_id, model_id, capability, state, evidence_ref, contract_version, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [uuidv7(), id, model, capability, state, ref.trim(), adapter.contractVersion, actor],
      );
    });
    await this.audit.record({
      action: 'ai.provider.capability_evidence_recorded',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: {
        code: r.code,
        model,
        capability,
        state,
        evidenceRef: ref.trim(),
        contractVersion: adapter.contractVersion,
      },
    });
    return this.view(r);
  }

  /**
   * The live capability probe (S-AG4, SCR-K-11 item 4). The action is part of the contract but is NOT available yet: running it is a live provider call that needs the owner's
   * approval of the probe (D9), the agreement (D2), a credential (D4) and the live gate (D3). The request is validated and the refusal is audited; nothing is sent anywhere.
   */
  async probeToolUse(actor: string, id: string, b: Record<string, unknown>): Promise<ProviderDto> {
    const r = await this.load(id);
    const worst = probeWorstCase();
    if (typeof b.approvalRef !== 'string' || b.approvalRef.length < 3 || b.approvalRef.length > 200)
      throw new ProblemException(
        'validation_failed',
        'approvalRef (the recorded approval of the probe) is required',
      );
    if (!Number.isInteger(b.maxTotalTokens) || (b.maxTotalTokens as number) < worst.totalTokens)
      throw new ProblemException(
        'validation_failed',
        `maxTotalTokens must be an integer of at least the worst case (${worst.totalTokens})`,
      );
    const refuse = async (reason: string, message: string): Promise<never> => {
      await this.audit.record({
        action: 'ai.provider.probe_refused',
        actorUserId: actor,
        actorType: 'user',
        resource: { type: 'model_provider', id },
        outcome: 'failure',
        detail: { code: r.code, reason },
      });
      throw new ProblemException('unsupported_capability', `${message}; nothing was sent`);
    };
    // gate 1 (D9): the owner's recorded approval of THIS probe, by reference; the request can lower the token cap, never raise it
    const approval = this.cfg.probeApprovals?.find((x) => x.ref === b.approvalRef);
    if (!approval)
      return refuse(
        'not_approved_d9',
        'the live probe is not available: no recorded approval (D9) matches this reference',
      );
    // gate 2 (D3): the live gate of this provider (a dev-reference mock-*/local-* adapter makes no live request, so it needs none)
    const devReference = /^(mock|local)-/.test(r.code as string);
    if (!devReference && !(this.cfg.liveProviders ?? []).includes(r.code as string))
      return refuse(
        'live_gate_closed_d3',
        'the live probe is not available: the live gate for this provider is closed (D3)',
      );
    // gate 3 (D2/D4): the agreement is attested and a credential exists (a real provider only)
    if (!devReference) {
      const terms = r.data_terms as { attested?: boolean };
      if (terms.attested !== true || !r.attestation_ref)
        return refuse(
          'not_attested_d2',
          'the live probe is not available: the data terms are not attested (D2)',
        );
      if (!r.vault_ref)
        return refuse('no_credential_d4', 'the live probe is not available: no credential (D4)');
    }
    const adapter = this.registry.get(r.code as string);
    if (!adapter)
      return refuse(
        'adapter_not_registered',
        'the live probe is not available: no adapter is registered for this provider',
      );
    const model = typeof b.model === 'string' ? b.model : '';
    const cap = Math.min(b.maxTotalTokens as number, approval.maxTotalTokens);
    await this.audit.record({
      action: 'ai.provider.probe_started',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: {
        code: r.code,
        model,
        approvalRef: approval.ref,
        maxRequests: approval.maxRequests,
        maxTotalTokens: cap,
      },
    });
    let report;
    try {
      report = await runCapabilityProbe(adapter, model, {
        ref: approval.ref,
        approvedBy: approval.approvedBy,
        environment: 'non-production',
        maxRequests: approval.maxRequests,
        maxTotalTokens: cap,
      });
    } catch (e) {
      if (e instanceof ProbeRefused)
        throw new ProblemException('validation_failed', e.message.slice(0, 200));
      throw e;
    }
    // the report is the evidence: one row per capability (VERIFIED only when the whole rule held; anything else is recorded as NOT VERIFIED), in dependency order
    for (const capability of ['tool-use', 'parallel-tool-calls', 'streaming-tool-calls'] as const) {
      const declared = adapter.models().find((m) => m.modelId === model)?.capabilities;
      if (!declared?.includes(capability)) continue;
      await this.recordCapabilityEvidence(actor, id, {
        model,
        capability,
        state: report.capabilities[capability],
        evidenceRef: `probe:${approval.ref}:${report.startedAt}`.slice(0, 200),
      });
    }
    await this.audit.record({
      action: 'ai.provider.probe_finished',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: report.stoppedEarly ? 'failure' : 'success',
      detail: {
        code: r.code,
        model,
        approvalRef: approval.ref,
        requests: report.requests,
        totalTokens: report.totalTokens,
        stoppedEarly: report.stoppedEarly ?? null,
        capabilities: report.capabilities,
      },
    });
    return this.view(await this.load(id));
  }

  /**
   * LIVE connection test of the stored key (Claude only for now). Read-only on the provider's side (a model listing: no prompt, no customer data, nothing billed)
   * and read-only here: it changes nothing in the database. The key is read from the sealed store inside this method and never returned, logged or audited:
   * the audit event carries only the outcome and the HTTP status. Dev profile only, like storing the key (D-12).
   */
  async testConnection(
    actor: string,
    id: string,
  ): Promise<ProbeResult & { checkedAt: string; live: true }> {
    if (!this.secrets || !this.probe || process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'testing the connection is not available in this profile: the production vault is not decided yet (D-12)',
      );
    const r = await this.load(id);
    if (r.adapter !== 'anthropic')
      throw new ProblemException(
        'unsupported_capability',
        'a connection test exists for Claude only',
      );
    const ref = (r.vault_ref as string | null) ?? null;
    if (!ref || !/^vault:\/\/(dev|mem)\/ai-/.test(ref))
      throw new ProblemException('validation_failed', 'save a key first, then test the connection');
    // a connection test is a LIVE request to the vendor made with the key: it needs the owner's approval for live calls to this provider (AI_LIVE_PROVIDERS), like any call
    if (!this.cfg.liveProviders?.includes(r.code as string))
      throw new ProblemException(
        'unsupported_capability',
        "live calls to this provider are not approved in this environment yet (credentials, data terms and residency need the owner's approval, S-AG4)",
      );
    const key = await this.secrets.get(ref).catch(() => null);
    if (!key)
      throw new ProblemException(
        'validation_failed',
        'the stored key could not be read: save it again',
      );
    const res = await this.probe(key);
    await this.audit.record({
      action: 'ai.provider.connection_tested',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: res.outcome === 'ok' ? 'success' : 'failure',
      detail: { code: r.code, outcome: res.outcome, httpStatus: res.httpStatus ?? null },
    });
    return { ...res, checkedAt: new Date().toISOString(), live: true };
  }

  /** Removes the stored key and the reference; the provider is disabled (it cannot run without a credential). */
  async clearCredential(actor: string, id: string): Promise<ProviderDto> {
    const r = await this.load(id);
    const ref = (r.vault_ref as string | null) ?? null;
    if (this.secrets && ref && /^vault:\/\/(dev|mem)\/ai-/.test(ref))
      await this.secrets.delete(ref).catch(() => undefined);
    const row = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE ai.model_providers SET vault_ref=NULL, enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL, updated_at=now(), version=version+1 WHERE id=$1 RETURNING *`,
            [id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'ai.provider.credential_cleared',
      actorUserId: actor,
      actorType: 'user',
      resource: { type: 'model_provider', id },
      outcome: 'success',
      detail: { code: r.code },
    });
    return this.view(row);
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
