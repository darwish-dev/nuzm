import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { assertTransition, type OperationState } from '@nuzm/domain';
import {
  CAPABILITY_IDS,
  VaultError,
  type CapabilityState,
  type CatalogSnapshot,
  type EvidenceKind,
  type RawEvidence,
  type VaultClient,
} from '@nuzm/adapter-contracts';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import type { AdapterRegistry } from './adapter-registry';
import { isProduction } from './adapter-registry';
import { canonicalJson, sha256, type Row } from './common';

export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The weakest kind wins: one mock item makes the whole evidence `mock`; only all-live evidence is `live`. */
export function weakestKind(evidence: readonly RawEvidence[]): EvidenceKind {
  if (evidence.some((e) => e.kind === 'mock')) return 'mock';
  if (evidence.some((e) => e.kind === 'fixture')) return 'fixture';
  return evidence.length ? 'live' : 'mock';
}

/**
 * Runs platform provider jobs (docs/09 §8): `verification` = vault ref resolves → capability probe → catalog (regions with evidence, plans)
 * → health; `catalog_sync` = catalog only. Capabilities and verified regions come ONLY from what the adapter's probe/listing returned,
 * stored with redacted evidence; a region missing from a new listing is `withdrawn` and its offers vanish at once.
 */
export class CatalogService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapters: AdapterRegistry,
    private readonly vault: VaultClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Fire-and-forget execution used by the API after it returned 202. Errors are recorded on the job, never thrown. */
  kick(jobId: string): void {
    setImmediate(
      () =>
        void this.run(jobId).catch((e) =>
          console.error(JSON.stringify({ cloud_job_error: (e as Error).message })),
        ),
    );
  }

  private async transition(
    jobId: string,
    to: OperationState,
    patch: { result?: unknown; error?: unknown } = {},
  ): Promise<boolean> {
    return this.db.withPlatformScope(async (c) => {
      const r = (
        await c.query(`SELECT state FROM cloud.provider_jobs WHERE id = $1 FOR UPDATE`, [jobId])
      ).rows[0];
      if (!r) return false;
      assertTransition(r.state as OperationState, to);
      await c.query(
        `UPDATE cloud.provider_jobs SET state = $2, result = coalesce($3::jsonb, result), error = coalesce($4::jsonb, error), attempts = attempts + (CASE WHEN $2 = 'running' THEN 1 ELSE 0 END), updated_at = now() WHERE id = $1`,
        [
          jobId,
          to,
          patch.result === undefined ? null : JSON.stringify(patch.result),
          patch.error === undefined ? null : JSON.stringify(patch.error),
        ],
      );
      return true;
    });
  }

  async run(jobId: string): Promise<void> {
    const job = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM cloud.provider_jobs WHERE id = $1`, [jobId])).rows[0] as
          Row | undefined,
    );
    if (!job || job.state !== 'pending') return;
    await this.transition(jobId, 'running');
    try {
      const result = job.kind === 'verification' ? await this.verify(job) : await this.sync(job);
      await this.transition(jobId, 'succeeded', { result });
    } catch (e) {
      const f =
        e instanceof JobFailure
          ? e
          : new JobFailure(
              'unexpected_error',
              this.adapters.redactor.string((e as Error).message ?? 'error'),
            );
      await this.transition(jobId, 'failed', { error: { code: f.code, message: f.message } });
      await this.audit.record({
        action: 'provider.job.failed',
        resource: { type: 'provider_account', id: job.account_id as string },
        outcome: 'failure',
        detail: { jobId, kind: job.kind, code: f.code },
      });
    }
  }

  private async loadAccount(accountId: string) {
    const a = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT a.id, a.name, a.vault_ref, a.status, p.key AS provider_key, p.adapter_id, p.status AS provider_status, p.environment_policy FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id WHERE a.id = $1`,
            [accountId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!a) throw new JobFailure('account_not_found', 'provider account not found');
    if (a.status !== 'active' || a.provider_status !== 'active')
      throw new JobFailure('account_disabled', 'the account or its provider is disabled');
    if (a.environment_policy === 'non_production_only' && isProduction())
      throw new JobFailure('provider_not_permitted', 'this provider is non-production only');
    const adapter = this.adapters.compute(a.adapter_id as string);
    const entry = this.adapters.entry(a.adapter_id as string);
    if (!adapter || !entry)
      throw new JobFailure(
        'adapter_not_available',
        `no adapter "${a.adapter_id}" is registered in this deployment`,
      );
    if (entry.requiresCredentials) {
      try {
        await this.vault.resolve(a.vault_ref as string); // registers the secret values with the redactor; the values go nowhere else
      } catch (e) {
        if (e instanceof VaultError)
          throw new JobFailure(
            e.code === 'blocked' ? 'vault_blocked' : 'credential_unresolvable',
            e.message,
          );
        throw new JobFailure(
          'credential_unresolvable',
          'the credential reference could not be resolved',
        );
      }
    }
    return { account: a, adapter };
  }

  private async storeEvidence(
    c: PoolClient,
    accountId: string,
    kind: EvidenceKind,
    operation: string,
    capturedAt: string,
    payload: unknown,
    jobId: string,
  ): Promise<string> {
    const redacted = this.adapters.redactor.deep(payload);
    const id = uuidv7();
    await c.query(
      `INSERT INTO cloud.evidence_items (id, account_id, kind, operation, captured_at, content_hash, redacted, job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        accountId,
        kind,
        operation,
        capturedAt,
        sha256(canonicalJson(redacted)),
        JSON.stringify(redacted),
        jobId,
      ],
    );
    return `evidence:${id}`;
  }

  private async verify(job: Row) {
    const { account, adapter } = await this.loadAccount(job.account_id as string);
    const ctx = this.adapters.ctx(
      { id: account.id as string, vaultRef: account.vault_ref as string },
      (job.trace_id as string | null) ?? String(job.id),
    );
    // 1) capability probe (read-only, side-effect free)
    const report = await adapter.probe(ctx).catch((e: Error) => {
      throw new JobFailure('probe_failed', this.adapters.redactor.string(e.message));
    });
    const probeRef = await this.db.withPlatformScope((c) =>
      this.storeEvidence(
        c,
        account.id as string,
        weakestKind(report.evidence),
        'probe',
        report.probedAt,
        report,
        job.id as string,
      ),
    );
    const changes = await this.db.withPlatformScope(async (c) => {
      const before = new Map(
        (
          await c.query(
            `SELECT capability_id, state FROM cloud.provider_capabilities WHERE account_id = $1`,
            [account.id],
          )
        ).rows.map((r) => [r.capability_id as string, r.state as string]),
      );
      const diff: { capabilityId: string; from: string; to: string }[] = [];
      for (const id of CAPABILITY_IDS) {
        const st: CapabilityState = report.capabilities[id] ?? 'unknown';
        const was = before.get(id) ?? 'unknown';
        if (st !== was) diff.push({ capabilityId: id, from: was, to: st });
        await c.query(
          `INSERT INTO cloud.provider_capabilities (account_id, capability_id, state, probed_at, evidence_ref) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (account_id, capability_id) DO UPDATE SET state = EXCLUDED.state, probed_at = EXCLUDED.probed_at, evidence_ref = EXCLUDED.evidence_ref`,
          [account.id, id, st, report.probedAt, probeRef],
        );
      }
      return diff;
    });
    if (changes.length)
      await this.audit.record({
        action: 'provider.capability.changed',
        resource: { type: 'provider_account', id: account.id as string },
        outcome: 'success',
        detail: { jobId: job.id, changes },
      });
    // 2) catalog: regions (with evidence) and plans
    const catalog = await this.sync(job);
    // 3) health
    const health = await adapter
      .health(ctx)
      .catch(() => ({ state: 'unhealthy' as const, checkedAt: this.now().toISOString() }));
    this.adapters.noteHealth(account.id as string, health.state);
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE cloud.provider_accounts SET verified_at = now(), health_state = $2, last_health_at = now(), breaker_state = $3, updated_at = now(), version = version + 1 WHERE id = $1`,
        [account.id, health.state, JSON.stringify(this.adapters.breaker(account.id as string))],
      );
      await this.audit.record({
        action: 'provider.account.verified',
        resource: { type: 'provider_account', id: account.id as string },
        outcome: 'success',
        detail: { jobId: job.id, probeRef, ...catalog },
      });
    });
    return {
      probeRef,
      capabilities: summarize(report.capabilities),
      ...catalog,
      health: health.state,
    };
  }

  private async sync(job: Row) {
    const { account, adapter } = await this.loadAccount(job.account_id as string);
    const ctx = this.adapters.ctx(
      { id: account.id as string, vaultRef: account.vault_ref as string },
      (job.trace_id as string | null) ?? String(job.id),
    );
    const snap = await adapter.catalog(ctx).catch((e: Error) => {
      throw new JobFailure('catalog_failed', this.adapters.redactor.string(e.message));
    });
    return this.db.withPlatformScope(async (c) =>
      this.applyCatalog(c, account.id as string, snap, job.id as string),
    );
  }

  private async applyCatalog(
    c: PoolClient,
    accountId: string,
    snap: CatalogSnapshot,
    jobId: string,
  ) {
    const regionEvidence = snap.regions.map((r) => ({
      providerRegionId: r.providerRegionId,
      countryCode: r.countryCode,
      verifiedAt: r.verifiedAt,
      evidence: r.evidence,
    }));
    const allEvidence = [...snap.evidence, ...snap.regions.flatMap((r) => r.evidence)];
    const kind = weakestKind(allEvidence);
    const regionsRef = await this.storeEvidence(
      c,
      accountId,
      kind,
      'catalog',
      snap.takenAt,
      { regions: regionEvidence, evidence: snap.evidence },
      jobId,
    );
    const seenRegions: string[] = [];
    let verified = 0;
    let listed = 0;
    for (const r of snap.regions) {
      seenRegions.push(r.providerRegionId);
      const isVerified =
        !!r.verifiedAt && r.evidence.length > 0 && !Number.isNaN(Date.parse(r.verifiedAt));
      if (isVerified) verified++;
      else listed++;
      await c.query(
        `INSERT INTO cloud.provider_regions (id, account_id, provider_region_id, country_code, display_name, state, verified_at, evidence_ref, evidence_kind, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (account_id, provider_region_id) DO UPDATE SET country_code = EXCLUDED.country_code, display_name = EXCLUDED.display_name, state = EXCLUDED.state,
           verified_at = EXCLUDED.verified_at, evidence_ref = EXCLUDED.evidence_ref, evidence_kind = EXCLUDED.evidence_kind, last_seen_at = now()`,
        [
          uuidv7(),
          accountId,
          r.providerRegionId,
          r.countryCode.toUpperCase(),
          r.displayName ?? null,
          isVerified ? 'verified' : 'listed',
          isVerified ? r.verifiedAt : null,
          isVerified ? `${regionsRef}#${r.providerRegionId}` : null,
          isVerified ? weakestKind(r.evidence) : null,
        ],
      );
    }
    const withdrawn = (
      await c.query(
        `UPDATE cloud.provider_regions SET state = 'withdrawn', verified_at = NULL, evidence_ref = NULL, evidence_kind = NULL
          WHERE account_id = $1 AND provider_region_id <> ALL($2::text[]) AND state <> 'withdrawn'`,
        [accountId, seenRegions],
      )
    ).rowCount;
    const regionIds = new Map(
      (
        await c.query(
          `SELECT id, provider_region_id FROM cloud.provider_regions WHERE account_id = $1`,
          [accountId],
        )
      ).rows.map((r) => [r.provider_region_id as string, r.id as string]),
    );
    const seenPlans: string[] = [];
    for (const p of snap.plans) {
      const regionId = regionIds.get(p.providerRegionId);
      if (!regionId || !seenRegions.includes(p.providerRegionId)) continue;
      const price = p.price && /^\d+$/.test(p.price.amountMinor) ? p.price : undefined; // never store a float or malformed price
      const row = (
        await c.query(
          `INSERT INTO cloud.provider_plans (id, account_id, region_id, plan_ref, vcpu, memory_mb, disk_gb, bandwidth, provider_price_minor, currency, period, availability, last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
           ON CONFLICT (account_id, region_id, plan_ref) DO UPDATE SET vcpu = EXCLUDED.vcpu, memory_mb = EXCLUDED.memory_mb, disk_gb = EXCLUDED.disk_gb, bandwidth = EXCLUDED.bandwidth,
             provider_price_minor = EXCLUDED.provider_price_minor, currency = EXCLUDED.currency, period = EXCLUDED.period, availability = EXCLUDED.availability, last_seen_at = now()
           RETURNING id`,
          [
            uuidv7(),
            accountId,
            regionId,
            p.planRef,
            p.vcpu,
            p.memoryMb,
            p.diskGb,
            p.bandwidth ?? null,
            price?.amountMinor ?? null,
            price?.currency ?? null,
            price?.period ?? null,
            p.availability,
          ],
        )
      ).rows[0]!;
      seenPlans.push(row.id as string);
    }
    await c.query(
      `UPDATE cloud.provider_plans SET availability = 'unavailable' WHERE account_id = $1 AND id <> ALL($2::uuid[]) AND availability <> 'unavailable'`,
      [accountId, seenPlans],
    );
    const hash = sha256(
      canonicalJson({
        regions: snap.regions.map((r) => ({
          id: r.providerRegionId,
          c: r.countryCode,
          v: !!r.verifiedAt,
        })),
        plans: snap.plans.map((p) => ({
          r: p.providerRegionId,
          p: p.planRef,
          v: p.vcpu,
          m: p.memoryMb,
          d: p.diskGb,
          a: p.availability,
          x: p.price ?? null,
        })),
      }),
    );
    await c.query(
      `INSERT INTO cloud.catalog_snapshots (id, account_id, taken_at, content_hash, payload_ref, region_count, plan_count, job_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        uuidv7(),
        accountId,
        snap.takenAt,
        hash,
        regionsRef,
        snap.regions.length,
        snap.plans.length,
        jobId,
      ],
    );
    await this.audit.record({
      action: 'provider.catalog.synced',
      resource: { type: 'provider_account', id: accountId },
      outcome: 'success',
      detail: {
        jobId,
        regions: snap.regions.length,
        plans: seenPlans.length,
        withdrawn,
        contentHash: hash,
      },
    });
    return {
      regions: { verified, listed, withdrawn: withdrawn ?? 0 },
      plans: seenPlans.length,
      contentHash: hash,
      evidenceRef: regionsRef,
      evidenceKind: kind,
    };
  }
}

const summarize = (caps: Record<string, CapabilityState>) => ({
  supported: Object.values(caps).filter((s) => s === 'supported').length,
  unsupported: Object.values(caps).filter((s) => s === 'unsupported').length,
  unknown:
    CAPABILITY_IDS.length -
    Object.values(caps).filter((s) => s === 'supported' || s === 'unsupported').length,
});
