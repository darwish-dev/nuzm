import { v7 as uuidv7 } from 'uuid';
import {
  DATA_SERVICES,
  FAMILY_PATTERN,
  REQUIRED_CAPABILITIES,
  type DataService,
} from '@nuzm/adapter-data';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { DataAdapterRegistry, type AnyDataAdapter } from './adapter-registry';
import { DataFlags } from './flags';
import { isUuid, type Row } from './model';

export interface ProviderDto {
  id: string;
  service: string;
  family: string;
  providerCode: string;
  providerAccountId: string | null;
  environment: 'local' | 'staging' | 'production';
  enabled: boolean;
  verifiedAt: string | null;
  evidenceRef: string | null;
  adrRef: string | null;
  adrAcceptedAt: string | null;
  probe: {
    probedAt: string;
    evidenceKinds: string[];
    passed: boolean;
    capabilities: Record<string, string>;
  } | null;
  config: Record<string, unknown>;
  requestedBy: string | null;
  approvedBy: string | null;
  enabledAt: string | null;
  /** Why enabling is blocked right now (empty = nothing blocks it). */
  blockers: string[];
  version: number;
  updatedAt: string;
}
const iso = (v: unknown) => (v ? (v as Date).toISOString() : null);

/** What a probe result must contain before the service accepts it as "passing". */
export const probePassed = (service: DataService, caps: Record<string, string>): boolean =>
  REQUIRED_CAPABILITIES[service].every((id) => caps[id] === 'supported');

const REF = /^[A-Za-z0-9][A-Za-z0-9 ._:/#-]{2,299}$/;

/**
 * Provider selection config (M08 S32 task 1, docs/04 `GET/POST /v1/admin/data-providers`). No provider is chosen here: a row says WHICH adapter/account
 * Nuzm MAY use and whether it IS enabled. Enabling needs, and the database re-checks: a probe that passed with every required capability `supported`,
 * `verified_at` and an evidence reference (a human-signed evidence index entry), and — outside environment=local — an ADR acceptance recorded by a person,
 * `live` evidence in that probe, and a SECOND approver. Dev-reference providers (`mock-*`) are `local` only and refused in production. The agent can never
 * accept an ADR or provide evidence: both are inputs from people.
 */
export class DataProviderService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly registry: DataAdapterRegistry,
    private readonly flags: DataFlags,
  ) {}

  private dto(r: Row): ProviderDto {
    const probe = (r.probe as ProviderDto['probe']) ?? null;
    const blockers: string[] = [];
    const env = r.environment as ProviderDto['environment'];
    if (!this.registry.get(r.service as DataService, r.provider_code as string))
      blockers.push('adapter_not_registered');
    if (!probe) blockers.push('not_probed');
    else if (!probe.passed) blockers.push('probe_failed');
    if (!r.verified_at || !r.evidence_ref) blockers.push('evidence_missing');
    if (env !== 'local') {
      if (!r.adr_ref || !r.adr_accepted_at) blockers.push('adr_not_accepted');
      if (probe && !probe.evidenceKinds.includes('live')) blockers.push('probe_not_live');
      if (!r.requested_by) blockers.push('enable_not_requested');
      else if (!r.approved_by) blockers.push('second_approver_missing');
    }
    return {
      id: r.id as string,
      service: r.service as string,
      family: r.family as string,
      providerCode: r.provider_code as string,
      providerAccountId: (r.provider_account_id as string | null) ?? null,
      environment: env,
      enabled: r.enabled as boolean,
      verifiedAt: iso(r.verified_at),
      evidenceRef: (r.evidence_ref as string | null) ?? null,
      adrRef: (r.adr_ref as string | null) ?? null,
      adrAcceptedAt: iso(r.adr_accepted_at),
      probe,
      config: (r.config as Record<string, unknown>) ?? {},
      requestedBy: (r.requested_by as string | null) ?? null,
      approvedBy: (r.approved_by as string | null) ?? null,
      enabledAt: iso(r.enabled_at),
      blockers: r.enabled ? [] : blockers,
      version: r.version as number,
      updatedAt: iso(r.updated_at)!,
    };
  }

  async list(filter: { service?: string } = {}): Promise<{ items: ProviderDto[] }> {
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.data_providers WHERE ($1::text IS NULL OR service = $1) ORDER BY service, provider_code, id`,
            [filter.service ?? null],
          )
        ).rows as Row[],
    );
    return { items: rows.map((r) => this.dto(r)) };
  }
  private async load(id: string): Promise<Row> {
    if (!isUuid(id)) throw new ProblemException('validation_failed', 'id must be a uuid');
    const r = (await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM data.data_providers WHERE id = $1`, [id])).rows[0],
    )) as Row | undefined;
    if (!r) throw new ProblemException('not_found');
    return r;
  }

  /** Create or update the selection config (never the enabled flag). */
  async configure(actor: string, body: Record<string, unknown>): Promise<ProviderDto> {
    const service = body.service;
    if (typeof service !== 'string' || !(DATA_SERVICES as readonly string[]).includes(service))
      throw new ProblemException(
        'validation_failed',
        `service must be one of ${DATA_SERVICES.join(', ')}`,
      );
    const family = body.family;
    if (typeof family !== 'string' || !FAMILY_PATTERN.test(family))
      throw new ProblemException(
        'validation_failed',
        'family must be provider-<name> or self-operated-<name>',
      );
    const code = body.providerCode;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(code))
      throw new ProblemException('validation_failed', 'providerCode must be a lower-case slug');
    const environment = body.environment ?? 'production';
    if (environment !== 'local' && environment !== 'staging' && environment !== 'production')
      throw new ProblemException(
        'validation_failed',
        'environment must be local, staging or production',
      );
    const dev = /^(mock|local)-/.test(code);
    if (dev && environment !== 'local')
      throw new ProblemException(
        'validation_failed',
        'a dev-reference provider (mock-*, local-*) can only be environment=local',
      );
    if (!dev && environment === 'local')
      throw new ProblemException(
        'validation_failed',
        'environment=local is for dev-reference providers (mock-*, local-*) only',
      );
    if (dev && process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'validation_failed',
        'dev-reference providers can never be configured in production',
      );
    const account = body.providerAccountId ?? null;
    if (
      account !== null &&
      (typeof account !== 'string' || account.length < 1 || account.length > 200)
    )
      throw new ProblemException(
        'validation_failed',
        'providerAccountId must be a string of 1..200 characters',
      );
    const config = (body.config ?? {}) as Record<string, unknown>;
    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config) ||
      JSON.stringify(config).length > 8000
    )
      throw new ProblemException(
        'validation_failed',
        'config must be an object of at most 8000 characters',
      );
    // credentials are NEVER accepted as values: only a vault reference
    for (const k of Object.keys(config))
      if (/(secret|password|token|api_?key|private)/i.test(k) && !(k === 'credentialRef'))
        throw new ProblemException(
          'validation_failed',
          `config.${k}: credential values are never accepted, send a vault reference as credentialRef`,
        );
    if (
      config.credentialRef !== undefined &&
      !/^vault:\/\/[A-Za-z0-9][A-Za-z0-9._\-/]{1,200}$/.test(String(config.credentialRef))
    )
      throw new ProblemException(
        'validation_failed',
        'config.credentialRef must be a vault:// reference',
      );
    const adrRef = body.adrRef ?? null;
    if (adrRef !== null && (typeof adrRef !== 'string' || !/^ADR-[0-9]{3}$/.test(adrRef)))
      throw new ProblemException('validation_failed', 'adrRef must look like ADR-050');
    const id = (body.id as string | undefined) ?? undefined;
    try {
      const out = await this.db.withPlatformScope(async (c) => {
        if (id) {
          if (!isUuid(id)) throw new ProblemException('validation_failed', 'id must be a uuid');
          const cur = (
            await c.query(`SELECT * FROM data.data_providers WHERE id = $1 FOR UPDATE`, [id])
          ).rows[0] as Row | undefined;
          if (!cur) throw new ProblemException('not_found');
          if (cur.enabled)
            throw new ProblemException(
              'conflict',
              'disable the provider before changing its configuration',
            );
          if (cur.service !== service || cur.provider_code !== code)
            throw new ProblemException(
              'validation_failed',
              'service and providerCode of an existing row cannot change',
            );
          // a configuration change invalidates the previous probe and approvals: they described another configuration
          const r = (
            await c.query(
              `UPDATE data.data_providers SET family=$2, provider_account_id=$3, environment=$4, config=$5, adr_ref=coalesce($6, adr_ref), probe=NULL, verified_at=NULL, evidence_ref=NULL,
                      requested_by=NULL, approved_by=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
              [id, family, account, environment, JSON.stringify(config), adrRef],
            )
          ).rows[0] as Row;
          return r;
        }
        return (
          await c.query(
            `INSERT INTO data.data_providers (id, service, family, provider_code, provider_account_id, environment, adr_ref, config, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
              uuidv7(),
              service,
              family,
              code,
              account,
              environment,
              adrRef,
              JSON.stringify(config),
              actor,
            ],
          )
        ).rows[0] as Row;
      });
      await this.audit.record({
        action: 'data.provider.configured',
        actorUserId: actor,
        resource: { type: 'data_provider', id: out.id as string },
        outcome: 'success',
        after: { service, family, providerCode: code, environment, enabled: false },
      });
      return this.dto(out);
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ProblemException('conflict', 'this provider/account is already configured');
      throw e;
    }
  }

  /** Run the adapter's read-only probe and store the result. A failing probe is data, not an error. */
  async probe(actor: string, id: string, traceId: string): Promise<ProviderDto> {
    const row = await this.load(id);
    const adapter = this.registry.get(
      row.service as DataService,
      row.provider_code as string,
    ) as AnyDataAdapter | null;
    if (!adapter)
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is registered for this provider in this deployment',
      );
    const ctx = this.registry.ctx(
      { id: row.id as string, config: (row.config as Record<string, unknown>) ?? {} },
      traceId,
    );
    const report = await adapter.probe(ctx);
    const caps = report.capabilities as Record<string, string>;
    const probe = {
      probedAt: report.probedAt,
      evidenceKinds: [...new Set(report.evidence.map((e) => e.kind))],
      passed: report.evidence.length > 0 && probePassed(row.service as DataService, caps),
      capabilities: caps,
    };
    const out = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE data.data_providers SET probe=$2, version=version+1, updated_at=now() WHERE id=$1 AND NOT enabled RETURNING *`,
            [id, JSON.stringify(probe)],
          )
        ).rows[0] as Row | undefined,
    );
    if (!out)
      throw new ProblemException('conflict', 'an enabled provider is re-probed after disabling it');
    await this.audit.record({
      action: 'data.provider.probed',
      actorUserId: actor,
      resource: { type: 'data_provider', id },
      outcome: 'success',
      after: { passed: probe.passed, evidenceKinds: probe.evidenceKinds },
    });
    return this.dto(out);
  }

  /** A person records that the owner accepted an ADR. The agent never calls this; only `admin:data:approve` can. */
  async recordAdrAcceptance(actor: string, id: string, adrRef: unknown): Promise<ProviderDto> {
    if (typeof adrRef !== 'string' || !/^ADR-[0-9]{3}$/.test(adrRef))
      throw new ProblemException('validation_failed', 'adrRef must look like ADR-050');
    const row = await this.load(id);
    if (row.enabled) throw new ProblemException('conflict', 'the provider is already enabled');
    const out = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE data.data_providers SET adr_ref=$2, adr_accepted_at=now(), adr_accepted_by=$3, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
            [id, adrRef, actor],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.provider.adr_accepted',
      actorUserId: actor,
      resource: { type: 'data_provider', id },
      outcome: 'success',
      after: { adrRef },
    });
    return this.dto(out);
  }

  /** First person: asks to enable, naming the evidence entry (a human-signed evidence index reference) and when it was verified. */
  async requestEnable(
    actor: string,
    id: string,
    evidenceRef: unknown,
    verifiedAt: unknown,
  ): Promise<ProviderDto> {
    if (typeof evidenceRef !== 'string' || !REF.test(evidenceRef))
      throw new ProblemException(
        'validation_failed',
        'evidenceRef must be a reference of 3..300 characters',
      );
    const when = typeof verifiedAt === 'string' ? new Date(verifiedAt) : null;
    if (!when || Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 60_000)
      throw new ProblemException(
        'validation_failed',
        'verifiedAt must be an RFC 3339 time that is not in the future',
      );
    const row = await this.load(id);
    if (row.enabled) throw new ProblemException('conflict', 'the provider is already enabled');
    const out = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE data.data_providers SET requested_by=$2, approved_by=NULL, evidence_ref=$3, verified_at=$4, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
            [id, actor, evidenceRef, when],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.provider.enable_requested',
      actorUserId: actor,
      resource: { type: 'data_provider', id },
      outcome: 'success',
      after: { evidenceRef },
    });
    return this.dto(out);
  }

  /** Second person (or, for environment=local, the same person): enables. Every precondition is checked here and again by CHECK constraints. */
  async enable(actor: string, id: string): Promise<ProviderDto> {
    const row = await this.load(id);
    const dto = this.dto(row);
    if (row.enabled) return dto;
    const local = row.environment === 'local';
    if (local && process.env.NODE_ENV === 'production')
      throw new ProblemException(
        'unsupported_capability',
        'dev-reference providers cannot be enabled in production',
      );
    const blockers = dto.blockers.filter(
      (b) => !(local && (b === 'enable_not_requested' || b === 'second_approver_missing')),
    );
    if (!local && row.requested_by === actor)
      throw new ProblemException(
        'forbidden',
        'a different person must approve enabling a provider (two-person rule)',
      );
    const hard = blockers.filter((b) => b !== 'second_approver_missing');
    if (hard.length > 0)
      throw new ProblemException(
        'unsupported_capability',
        `the provider cannot be enabled: ${hard.join(', ')}`,
        undefined,
        { blockers: hard },
      );
    try {
      const out = await this.db.withPlatformScope(
        async (c) =>
          (
            await c.query(
              `UPDATE data.data_providers SET enabled=true, enabled_at=now(), approved_by=$2, requested_by=coalesce(requested_by, $2), version=version+1, updated_at=now() WHERE id=$1 AND NOT enabled RETURNING *`,
              [id, actor],
            )
          ).rows[0] as Row,
      );
      await this.audit.record({
        action: 'data.provider.enabled',
        actorUserId: actor,
        resource: { type: 'data_provider', id },
        outcome: 'success',
        after: {
          service: row.service,
          providerCode: row.provider_code,
          environment: row.environment,
        },
      });
      return this.dto(out);
    } catch (e) {
      if ((e as { code?: string }).code === '23514')
        throw new ProblemException(
          'unsupported_capability',
          'the provider cannot be enabled: a precondition is not met',
        );
      throw e;
    }
  }

  async disable(actor: string, id: string): Promise<ProviderDto> {
    await this.load(id);
    const out = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `UPDATE data.data_providers SET enabled=false, enabled_at=NULL, requested_by=NULL, approved_by=NULL, version=version+1, updated_at=now() WHERE id=$1 RETURNING *`,
            [id],
          )
        ).rows[0] as Row,
    );
    await this.audit.record({
      action: 'data.provider.disabled',
      actorUserId: actor,
      resource: { type: 'data_provider', id },
      outcome: 'success',
    });
    return this.dto(out);
  }

  /**
   * The provider a customer request would use for `service`: enabled row ∧ flag `data.<service>.<provider>` on for the org ∧ an adapter registered here.
   * Otherwise 422 `unsupported_capability` (never a silent fallback, never a mock in production).
   */
  async resolveEnabled(
    orgId: string,
    service: DataService,
  ): Promise<{ row: ProviderDto; adapter: AnyDataAdapter }> {
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM data.data_providers WHERE service = $1 AND enabled ORDER BY created_at, id`,
            [service],
          )
        ).rows as Row[],
    );
    for (const r of rows) {
      const adapter = this.registry.get(service, r.provider_code as string);
      if (!adapter) continue;
      if (r.environment === 'local' && process.env.NODE_ENV === 'production') continue;
      if (!(await this.flags.enabled(orgId, service, r.provider_code as string))) continue;
      return { row: this.dto(r), adapter };
    }
    throw new ProblemException(
      'unsupported_capability',
      `no ${service} provider is enabled for this organization`,
    );
  }
  /** Same as `resolveEnabled` for a known provider id (the instance's own provider), without the flag-ordering search. */
  async byId(
    orgId: string,
    id: string,
    service: DataService,
  ): Promise<{ row: ProviderDto; adapter: AnyDataAdapter } | null> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) => (await c.query(`SELECT * FROM data.data_providers WHERE id = $1`, [id])).rows[0],
    )) as Row | undefined;
    if (!r) return null;
    const adapter = this.registry.get(service, r.provider_code as string);
    return adapter ? { row: this.dto(r), adapter } : null;
  }
}
