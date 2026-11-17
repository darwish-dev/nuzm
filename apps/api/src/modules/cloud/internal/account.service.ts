import { v7 as uuidv7 } from 'uuid';
import { CAPABILITY_IDS, isVaultRef } from '@nuzm/adapter-contracts';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import type { AdapterRegistry } from './adapter-registry';
import {
  UUID,
  body,
  iso,
  oneOf,
  pgCode,
  reqText,
  rejectCredentialValues,
  type Row,
} from './common';

export interface AccountDto {
  id: string;
  providerId: string;
  providerKey: string;
  adapterId: string;
  name: string;
  /** A `vault://` reference. Credential VALUES are never accepted, stored, logged or returned. */
  credentialRef: string;
  scopeNote: string | null;
  status: string;
  health: { state: string; lastHealthAt: string | null; breaker: unknown };
  spendCap: { amountMinor: string; currency: string } | null;
  verifiedAt: string | null;
  version: number;
  createdAt: string;
}
export interface JobDto {
  id: string;
  accountId: string;
  kind: 'verification' | 'catalog_sync';
  state: string;
  result: unknown;
  error: unknown;
  createdAt: string;
  updatedAt: string;
}

const SELECT = `SELECT a.*, p.key AS provider_key, p.adapter_id FROM cloud.provider_accounts a JOIN cloud.providers p ON p.id = a.provider_id`;
const CAP_STATES = ['supported', 'unsupported', 'unknown'];

const toDto = (r: Row): AccountDto => ({
  id: r.id as string,
  providerId: r.provider_id as string,
  providerKey: r.provider_key as string,
  adapterId: r.adapter_id as string,
  name: r.name as string,
  credentialRef: r.vault_ref as string,
  scopeNote: (r.scope_note as string | null) ?? null,
  status: r.status as string,
  health: {
    state: r.health_state as string,
    lastHealthAt: iso(r.last_health_at),
    breaker: r.breaker_state,
  },
  spendCap:
    r.spend_cap_minor == null
      ? null
      : {
          amountMinor: String(r.spend_cap_minor),
          currency: (r.spend_cap_currency as string).trim(),
        },
  verifiedAt: iso(r.verified_at),
  version: r.version as number,
  createdAt: iso(r.created_at)!,
});
const toJob = (r: Row): JobDto => ({
  id: r.id as string,
  accountId: r.account_id as string,
  kind: r.kind as JobDto['kind'],
  state: r.state as string,
  result: r.result ?? null,
  error: r.error ?? null,
  createdAt: iso(r.created_at)!,
  updatedAt: iso(r.updated_at)!,
});

function spendCap(
  b: Record<string, unknown>,
): { minor: string; currency: string } | null | undefined {
  if (!('spendCap' in b)) return undefined;
  if (b.spendCap === null) return null;
  const s = b.spendCap as { amountMinor?: unknown; currency?: unknown };
  if (
    !s ||
    typeof s.amountMinor !== 'string' ||
    !/^\d{1,15}$/.test(s.amountMinor) ||
    typeof s.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(s.currency)
  )
    throw new ProblemException(
      'validation_failed',
      'spendCap must be {amountMinor: integer string, currency: ISO 4217} or null',
    );
  return { minor: s.amountMinor, currency: s.currency };
}

/** Provider accounts (docs/04 §2.5, FR-CLD-03): vault REFERENCES only, never credential values. */
export class ProviderAccountService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly adapters: AdapterRegistry,
  ) {}

  async list(providerId?: string): Promise<AccountDto[]> {
    return this.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `${SELECT} WHERE ($1::uuid IS NULL OR a.provider_id = $1) ORDER BY a.created_at DESC, a.id`,
          [providerId ?? null],
        )
      ).rows.map(toDto),
    );
  }

  async get(id: string): Promise<AccountDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withPlatformScope(
      async (c) => (await c.query(`${SELECT} WHERE a.id = $1`, [id])).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return toDto(r);
  }

  async create(actorUserId: string, input: unknown): Promise<AccountDto> {
    const b = body(input);
    rejectCredentialValues(b);
    const providerId = b.providerId;
    if (typeof providerId !== 'string' || !UUID.test(providerId))
      throw new ProblemException('validation_failed', 'providerId must be a UUID');
    const name = reqText(b.name, 'name', 1, 100);
    if (!isVaultRef(b.credentialRef))
      throw new ProblemException(
        'credential_value_rejected',
        'credentialRef must be a vault reference (vault://…); credential values are never accepted',
      );
    const scopeNote =
      b.scopeNote === undefined || b.scopeNote === null
        ? null
        : reqText(b.scopeNote, 'scopeNote', 1, 500);
    const cap = spendCap(b);
    const id = uuidv7();
    try {
      await this.db.withPlatformScope(async (c) => {
        const p = (
          await c.query(`SELECT id, status FROM cloud.providers WHERE id = $1`, [providerId])
        ).rows[0];
        if (!p) throw new ProblemException('not_found', 'provider not found');
        if (p.status !== 'active') throw new ProblemException('conflict', 'provider is disabled');
        await c.query(
          `INSERT INTO cloud.provider_accounts (id, provider_id, name, vault_ref, scope_note, spend_cap_minor, spend_cap_currency, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            providerId,
            name,
            b.credentialRef,
            scopeNote,
            cap?.minor ?? null,
            cap?.currency ?? null,
            actorUserId,
          ],
        );
        await this.audit.record({
          action: 'provider.account.created',
          actorUserId,
          resource: { type: 'provider_account', id },
          outcome: 'success',
          after: {
            providerId,
            name,
            credentialRef: b.credentialRef,
            spendCap: cap ? { amountMinor: cap.minor, currency: cap.currency } : null,
          },
        });
      });
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException(
          'conflict',
          'an account with this name already exists for the provider',
        );
      throw e;
    }
    return this.get(id);
  }

  async update(
    actorUserId: string,
    id: string,
    ifMatch: number | null,
    input: unknown,
  ): Promise<AccountDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    if (ifMatch === null) throw new ProblemException('precondition_required');
    const b = body(input);
    rejectCredentialValues(b);
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length + 2}`);
    };
    if (b.name !== undefined) add('name', reqText(b.name, 'name', 1, 100));
    if (b.status !== undefined)
      add('status', oneOf(b.status, 'status', ['active', 'disabled'] as const));
    if (b.scopeNote !== undefined)
      add('scope_note', b.scopeNote === null ? null : reqText(b.scopeNote, 'scopeNote', 1, 500));
    if (b.credentialRef !== undefined) {
      if (!isVaultRef(b.credentialRef))
        throw new ProblemException(
          'credential_value_rejected',
          'credentialRef must be a vault reference (vault://…)',
        );
      add('vault_ref', b.credentialRef);
      add('verified_at', null); // a new credential reference must be verified again
    }
    const cap = spendCap(b);
    if (cap !== undefined) {
      add('spend_cap_minor', cap?.minor ?? null);
      add('spend_cap_currency', cap?.currency ?? null);
    }
    if (!sets.length)
      throw new ProblemException('validation_failed', 'no updatable field was provided');
    const before = await this.get(id);
    try {
      const n = await this.db.withPlatformScope(async (c) => {
        const r = await c.query(
          `UPDATE cloud.provider_accounts SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE id = $1 AND version = $2`,
          [id, ifMatch, ...params],
        );
        if (r.rowCount === 1)
          await this.audit.record({
            action: 'provider.account.updated',
            actorUserId,
            resource: { type: 'provider_account', id },
            outcome: 'success',
            before: {
              name: before.name,
              status: before.status,
              credentialRef: before.credentialRef,
            },
            after: { fields: Object.keys(b) },
          });
        return r.rowCount;
      });
      if (!n)
        throw new ProblemException('precondition_failed', 'the account changed; reload and retry');
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException(
          'conflict',
          'an account with this name already exists for the provider',
        );
      throw e;
    }
    return this.get(id);
  }

  /** Creates a pending platform job (verification or catalog sync). Returns the existing job for a repeated idempotency key. */
  async startJob(
    actorUserId: string,
    accountId: string,
    kind: JobDto['kind'],
    idempotencyKey?: string,
    traceId?: string,
  ): Promise<JobDto> {
    const account = await this.get(accountId);
    if (account.status !== 'active')
      throw new ProblemException('conflict', 'the provider account is disabled');
    const id = uuidv7();
    const job = await this.db.withPlatformScope(async (c) => {
      if (idempotencyKey) {
        const ex = (
          await c.query(
            `SELECT * FROM cloud.provider_jobs WHERE account_id = $1 AND kind = $2 AND idempotency_key = $3`,
            [accountId, kind, idempotencyKey],
          )
        ).rows[0];
        if (ex) return ex as Row;
      }
      const r = (
        await c.query(
          `INSERT INTO cloud.provider_jobs (id, account_id, kind, idempotency_key, trace_id, requested_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [id, accountId, kind, idempotencyKey ?? null, traceId ?? null, actorUserId],
        )
      ).rows[0] as Row;
      await this.audit.record({
        action: `provider.${kind === 'verification' ? 'verification' : 'catalog'}.requested`,
        actorUserId,
        resource: { type: 'provider_account', id: accountId },
        outcome: 'success',
        detail: { jobId: id },
      });
      return r;
    });
    return toJob(job);
  }

  async getJob(id: string): Promise<JobDto> {
    if (!UUID.test(id)) throw new ProblemException('not_found');
    const r = await this.db.withPlatformScope(
      async (c) => (await c.query(`SELECT * FROM cloud.provider_jobs WHERE id = $1`, [id])).rows[0],
    );
    if (!r) throw new ProblemException('not_found');
    return toJob(r);
  }

  /** The capability matrix: EVERY capability id appears; one the probe never reported is `unknown` (= unsupported). */
  async capabilities(accountId: string) {
    await this.get(accountId);
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT capability_id, state, probed_at, evidence_ref FROM cloud.provider_capabilities WHERE account_id = $1`,
            [accountId],
          )
        ).rows,
    );
    const by = new Map(rows.map((r) => [r.capability_id as string, r]));
    return {
      items: CAPABILITY_IDS.map((id) => {
        const r = by.get(id);
        const state = r && CAP_STATES.includes(r.state as string) ? (r.state as string) : 'unknown';
        return {
          capabilityId: id,
          state,
          effective: state === 'supported' ? 'supported' : 'unsupported',
          probedAt: iso(r?.probed_at),
          evidenceRef: (r?.evidence_ref as string | null) ?? null,
        };
      }),
    };
  }

  async regions(accountId: string) {
    await this.get(accountId);
    return {
      items: (
        await this.db.withPlatformScope(
          async (c) =>
            (
              await c.query(
                `SELECT * FROM cloud.provider_regions WHERE account_id = $1 ORDER BY provider_region_id`,
                [accountId],
              )
            ).rows,
        )
      ).map((r) => ({
        id: r.id as string,
        providerRegionId: r.provider_region_id as string,
        countryCode: (r.country_code as string).trim(),
        displayName: (r.display_name as string | null) ?? null,
        state: r.state as string,
        verifiedAt: iso(r.verified_at),
        evidenceRef: (r.evidence_ref as string | null) ?? null,
        evidenceKind: (r.evidence_kind as string | null) ?? null,
        lastSeenAt: iso(r.last_seen_at),
      })),
    };
  }

  async plans(accountId: string, regionId?: string) {
    await this.get(accountId);
    return {
      items: (
        await this.db.withPlatformScope(
          async (c) =>
            (
              await c.query(
                `SELECT p.*, r.provider_region_id FROM cloud.provider_plans p JOIN cloud.provider_regions r ON r.id = p.region_id WHERE p.account_id = $1 AND ($2::text IS NULL OR r.provider_region_id = $2) ORDER BY r.provider_region_id, p.plan_ref`,
                [accountId, regionId ?? null],
              )
            ).rows,
        )
      ).map((r) => ({
        id: r.id as string,
        providerRegionId: r.provider_region_id as string,
        planRef: r.plan_ref as string,
        vcpu: r.vcpu as number,
        memoryMb: r.memory_mb as number,
        diskGb: r.disk_gb as number,
        bandwidth: (r.bandwidth as string | null) ?? null,
        providerPrice:
          r.provider_price_minor == null
            ? null
            : {
                amountMinor: String(r.provider_price_minor),
                currency: (r.currency as string).trim(),
                period: r.period as string,
              },
        availability: r.availability as string,
        lastSeenAt: iso(r.last_seen_at),
      })),
    };
  }
}
