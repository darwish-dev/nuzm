import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import {
  isSupported,
  isVaultRef,
  type EvidenceKind,
  type RawEvidence,
} from '@nuzm/registrar-contracts';
import type { AuditSink } from '../../../common/audit';
import type { SecretStore } from '../../../common/secrets';
import { ProblemException } from '../../../common/errors';
import { UUID, badRequest, pgCode } from './common';
import type { DomainsConfig } from './ports';
import { RegistrarAccessService, type RegistrarAccount } from './registrar-access.service';

const SECRETISH =
  /(pass(word|wd)?|secret|api[-_]?key|private[-_]?key|credential|authcode|auth_code|^token$)/i;

/** Placeholder reference of an account whose credentials have not been entered yet (the column is NOT NULL). Nothing can resolve it. */
const UNSET_REF = 'vault://unset/';
const CRED_VALUE = /^[\x21-\x7E]{8,400}$/;

export interface RegistrarAccountDto {
  id: string;
  providerCode: string;
  label: string;
  environment: string;
  vaultRef: string;
  dataRegion: string;
  providerRegionId: string | null;
  currency: string;
  priority: number;
  enabled: boolean;
  registrarEnabled: boolean;
  health: string;
  capabilities: RegistrarAccount['capabilities'];
  /** Non-secret connection settings (base URL, reseller id, timeout). */
  settings: Record<string, unknown>;
  /** True when a credential reference exists. The credential itself is never returned. */
  credentialStored: boolean;
  tldCount: number;
  /** Where the capability matrix came from. Anything but `live` is shown as NOT VERIFIED (CLAUDE.md §5, HG-07-01). */
  evidenceKind: EvidenceKind | null;
  verification: 'NOT VERIFIED' | 'LIVE-VERIFIED' | 'NOT PROBED';
  probedAt: string | null;
}
const dto = (a: RegistrarAccount): RegistrarAccountDto => ({
  id: a.id,
  providerCode: a.providerCode,
  label: a.label,
  environment: a.environment,
  vaultRef: a.vaultRef,
  dataRegion: a.dataRegion,
  providerRegionId: a.providerRegionId,
  currency: a.currency,
  priority: a.priority,
  enabled: a.enabled,
  registrarEnabled: a.registrarEnabled,
  health: a.health,
  capabilities: a.capabilities,
  settings: a.settings,
  credentialStored: !a.vaultRef.startsWith(UNSET_REF),
  tldCount: a.tldSupport.length,
  evidenceKind: a.evidenceKind,
  verification:
    a.probedAt === null
      ? 'NOT PROBED'
      : a.evidenceKind === 'live'
        ? 'LIVE-VERIFIED'
        : 'NOT VERIFIED',
  probedAt: a.probedAt,
});

/** Admin registrar registry (M07 S28 task 6). References to the vault only; a credential VALUE in any field is refused (422 credential_value_rejected). */
export class RegistrarAdminService {
  constructor(
    private readonly db: Db,
    private readonly access: RegistrarAccessService,
    private readonly audit: AuditSink,
    private readonly cfg: DomainsConfig,
    /** Dev-only sealed secret store (D-12): typed credentials go here, only their `vault://` reference is kept. Absent = typed credentials are refused. */
    private readonly secrets?: SecretStore,
  ) {}

  async list() {
    const accounts = await this.access.listAccounts();
    const registrars = await this.db.withoutScope(
      async (c) =>
        (
          await c.query(
            `SELECT id, provider_code, title, contract_version, enabled FROM domains.registrars ORDER BY provider_code`,
          )
        ).rows,
    );
    return {
      registrars: registrars.map((r) => ({
        id: r.id as string,
        providerCode: r.provider_code as string,
        title: r.title as string,
        contractVersion: r.contract_version as string,
        enabled: r.enabled as boolean,
      })),
      accounts: accounts.map(dto),
    };
  }

  async createAccount(
    adminUserId: string,
    body: Record<string, unknown>,
  ): Promise<RegistrarAccountDto> {
    for (const k of Object.keys(body))
      if (SECRETISH.test(k) && k !== 'webhookSecretRef')
        throw new ProblemException(
          'credential_value_rejected',
          `field ${k} looks like a credential value; send a vault reference (vaultRef)`,
        );
    const providerCode = body.providerCode;
    const label = body.label;
    if (typeof providerCode !== 'string' || !/^[a-z][a-z0-9_-]{1,40}$/.test(providerCode))
      throw badRequest('providerCode is required');
    if (typeof label !== 'string' || label.trim().length < 1 || label.length > 100)
      throw badRequest('label is required (1..100 characters)');
    if (body.environment !== 'sandbox' && body.environment !== 'production')
      throw badRequest('environment must be sandbox or production');
    if (!isVaultRef(body.vaultRef))
      throw new ProblemException(
        'credential_value_rejected',
        'vaultRef must be a vault:// reference',
      );
    if (
      body.webhookSecretRef !== undefined &&
      body.webhookSecretRef !== null &&
      !isVaultRef(body.webhookSecretRef)
    )
      throw new ProblemException(
        'credential_value_rejected',
        'webhookSecretRef must be a vault:// reference',
      );
    if (
      typeof body.dataRegion !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(body.dataRegion)
    )
      throw badRequest(
        'dataRegion is required: the country or region where the registrar processes registrant data',
      );
    const currency = body.currency === undefined ? 'USD' : body.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      throw badRequest('currency must be an ISO 4217 code');
    const priority = body.priority === undefined ? 100 : body.priority;
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 10000
    )
      throw badRequest('priority must be an integer 0..10000');
    const id = uuidv7();
    try {
      await this.db.withPlatformScope(async (c) => {
        const reg = (
          await c.query(`SELECT id FROM domains.registrars WHERE provider_code = $1`, [
            providerCode,
          ])
        ).rows[0];
        if (!reg) throw new ProblemException('not_found', 'unknown registrar');
        await c.query(
          `INSERT INTO domains.registrar_accounts (id, registrar_id, label, environment, vault_ref, webhook_secret_ref, data_region, provider_region_id, currency, priority, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            reg.id,
            label.trim(),
            body.environment,
            body.vaultRef,
            body.webhookSecretRef ?? null,
            (body.dataRegion as string).toUpperCase(),
            typeof body.providerRegionId === 'string' ? body.providerRegionId : null,
            currency,
            priority,
            adminUserId,
          ],
        );
      });
    } catch (e) {
      if (pgCode(e) === '23514')
        throw badRequest('a value violates a registrar account constraint');
      throw e;
    }
    await this.audit.record({
      action: 'registrar.account.created',
      actorUserId: adminUserId,
      outcome: 'success',
      resource: { type: 'registrar_account', id },
      after: {
        providerCode,
        environment: body.environment,
        dataRegion: String(body.dataRegion).toUpperCase(),
      },
    });
    return dto((await this.access.getAccount(id))!);
  }

  /**
   * DNet connection settings (owner request 2026-11-21, D-50). ONE account per DNet registrar, created on the first save and updated after that.
   * Non-secret settings (label, environment, base URL, reseller id, timeout) go to `registrar_accounts.settings`. Credentials are either a `vault://` reference or,
   * outside production only (D-12), typed here: they go to the sealed secret store as one JSON blob and only the reference is kept; they are never stored in the
   * database, logged, audited or returned. Any save disables the account and clears its probe: it must be verified again before it can sell. There is no DNet
   * adapter until DNet's API documentation is supplied (HG-07-03), so a verification answers `unsupported_capability`: nothing is reported as connected.
   */
  async saveDnetSettings(
    adminUserId: string,
    body: Record<string, unknown>,
  ): Promise<RegistrarAccountDto> {
    return this.saveSettings('dnet', adminUserId, body);
  }

  /**
   * Connection settings of a registrar the admin console configures by hand (one account per registrar, created on the first save): `dnet` (no adapter yet) and
   * `dynadot` (Legacy API adapter). Non-secret settings are stored as typed; credentials are write-only (sealed store → only the reference is kept).
   */
  async saveSettings(
    providerCode: 'dnet' | 'dynadot',
    adminUserId: string,
    body: Record<string, unknown>,
  ): Promise<RegistrarAccountDto> {
    const dyn = providerCode === 'dynadot';
    const allowed = new Set([
      'label',
      'environment',
      ...(dyn ? ['searchBatch'] : ['baseUrl', 'resellerId']),
      'timeoutMs',
      'dataRegion',
      'currency',
      'vaultRef',
      'credentials',
    ]);
    for (const k of Object.keys(body)) if (!allowed.has(k)) throw badRequest(`unknown field ${k}`);
    const label = body.label === undefined ? (dyn ? 'Dynadot' : 'DNet') : body.label;
    if (typeof label !== 'string' || label.trim().length < 1 || label.length > 100)
      throw badRequest('label must be 1..100 characters');
    if (body.environment !== 'sandbox' && body.environment !== 'production')
      throw badRequest('environment must be sandbox or production');
    let baseUrl: string | null = null;
    if (body.baseUrl !== undefined && body.baseUrl !== null && body.baseUrl !== '') {
      const parse = (v: unknown): URL | null => {
        try {
          return typeof v === 'string' ? new URL(v) : null;
        } catch {
          return null;
        }
      };
      const u = parse(body.baseUrl);
      if (!u || u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
        throw badRequest('baseUrl must be an https URL without credentials, query or fragment');
      baseUrl = u.origin + (u.pathname === '/' ? '' : u.pathname.replace(/\/$/, ''));
    }
    let resellerId: string | null = null;
    if (body.resellerId !== undefined && body.resellerId !== null && body.resellerId !== '') {
      if (typeof body.resellerId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.resellerId))
        throw badRequest('resellerId must be 1..64 letters, digits, dot, dash or underscore');
      resellerId = body.resellerId;
    }
    const timeoutMs = body.timeoutMs === undefined ? 15_000 : body.timeoutMs;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 60_000
    )
      throw badRequest('timeoutMs must be an integer 1000..60000');
    const dataRegion = body.dataRegion === undefined ? (dyn ? 'US' : 'SA') : body.dataRegion;
    if (typeof dataRegion !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{1,39}$/.test(dataRegion))
      throw badRequest('dataRegion must be a country or region code');
    const currency = body.currency === undefined ? (dyn ? 'USD' : 'SAR') : body.currency;
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
      throw badRequest('currency must be an ISO 4217 code');

    // Dynadot: domains per `search` call (1 for a regular account; bulk accounts may send up to 100 — docs)
    const searchBatch = body.searchBatch === undefined ? 1 : body.searchBatch;
    if (
      dyn &&
      (typeof searchBatch !== 'number' ||
        !Number.isInteger(searchBatch) ||
        searchBatch < 1 ||
        searchBatch > 100)
    )
      throw badRequest('searchBatch must be an integer 1..100');

    let typed: { apiKey: string; apiSecret?: string } | null = null;
    if (body.credentials !== undefined && body.credentials !== null) {
      const c = body.credentials as Record<string, unknown>;
      if (typeof c !== 'object' || Array.isArray(c))
        throw badRequest('credentials must be an object');
      for (const k of Object.keys(c))
        if (k !== 'apiKey' && k !== 'apiSecret') throw badRequest(`unknown credential field ${k}`);
      if (typeof c.apiKey !== 'string' || !CRED_VALUE.test(c.apiKey.trim()))
        throw badRequest('apiKey must be 8 to 400 printable characters with no spaces');
      if (
        c.apiSecret !== undefined &&
        c.apiSecret !== '' &&
        (typeof c.apiSecret !== 'string' || !CRED_VALUE.test(c.apiSecret.trim()))
      )
        throw badRequest('apiSecret must be 8 to 400 printable characters with no spaces');
      typed = {
        apiKey: c.apiKey.trim(),
        ...(typeof c.apiSecret === 'string' && c.apiSecret !== ''
          ? { apiSecret: c.apiSecret.trim() }
          : {}),
      };
      if (!this.secrets || process.env.NODE_ENV === 'production')
        throw new ProblemException(
          'unsupported_capability',
          'storing credentials here is not available in this profile: the production vault is not decided yet (D-12); send a vault reference (vaultRef)',
        );
    }
    if (body.vaultRef !== undefined && body.vaultRef !== null && body.vaultRef !== '') {
      if (typed) throw badRequest('send either credentials or vaultRef, not both');
      if (!isVaultRef(body.vaultRef))
        throw new ProblemException(
          'credential_value_rejected',
          'vaultRef must be a vault:// reference',
        );
    }

    const existing = (await this.access.listAccounts()).find((a) => a.providerCode === providerCode);
    const id = existing?.id ?? uuidv7();
    let vaultRef: string | null =
      typeof body.vaultRef === 'string' && body.vaultRef !== '' ? body.vaultRef : null;
    if (typed)
      vaultRef = await this.secrets!.put(`domains-${providerCode}-${id}`, JSON.stringify(typed));
    const settings = dyn ? { timeoutMs, searchBatch } : { baseUrl, resellerId, timeoutMs };

    await this.db.withPlatformScope(async (c) => {
      if (existing) {
        await c.query(
          `UPDATE domains.registrar_accounts
              SET label=$2, environment=$3, data_region=$4, currency=$5, settings=$6::jsonb, vault_ref=COALESCE($7, vault_ref),
                  enabled=false, health='unknown', capabilities='{}'::jsonb, tld_support='[]'::jsonb, evidence_kind=NULL, probed_at=NULL, updated_at=now()
            WHERE id=$1`,
          [
            id,
            label.trim(),
            body.environment,
            dataRegion.toUpperCase(),
            currency,
            JSON.stringify(settings),
            vaultRef,
          ],
        );
      } else {
        const reg = (
          await c.query(`SELECT id FROM domains.registrars WHERE provider_code = $1`, [providerCode])
        ).rows[0];
        if (!reg) throw new ProblemException('not_found', 'unknown registrar');
        await c.query(
          `INSERT INTO domains.registrar_accounts (id, registrar_id, label, environment, vault_ref, data_region, currency, settings, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
          [
            id,
            reg.id,
            label.trim(),
            body.environment,
            vaultRef ?? `${UNSET_REF}${providerCode}`,
            dataRegion.toUpperCase(),
            currency,
            JSON.stringify(settings),
            adminUserId,
          ],
        );
      }
    });
    await this.audit.record({
      action: `registrar.${providerCode}.settings_saved`,
      actorUserId: adminUserId,
      outcome: 'success',
      resource: { type: 'registrar_account', id },
      after: {
        environment: body.environment,
        dataRegion: dataRegion.toUpperCase(),
        baseUrlHost: baseUrl ? new URL(baseUrl).host : null,
        resellerIdSet: resellerId !== null,
        timeoutMs,
        credentialsChanged: vaultRef !== null,
      },
    });
    return dto((await this.access.getAccount(id))!);
  }

  /**
   * Probe → capability matrix + TLD support (stored on the account; the `cloud.provider_capabilities` rows follow when M05 lands). `enable: true` additionally enables the
   * registrar and the account, but ONLY when the probe worked AND the evidence is live, or the profile is a non-production one that explicitly allows non-live registrars.
   */
  async verify(
    adminUserId: string,
    accountId: string,
    body: Record<string, unknown>,
    traceId: string,
  ) {
    if (!UUID.test(accountId)) throw new ProblemException('not_found');
    const account = await this.access.getAccount(accountId);
    if (!account) throw new ProblemException('not_found');
    const acc = this.access.accessFor(account, traceId);
    if (!acc)
      throw new ProblemException(
        'unsupported_capability',
        'no adapter is available for this registrar yet',
      );
    const enable = body.enable === true;
    let probe;
    let tlds;
    let health;
    try {
      probe = await acc.adapter.probe(acc.ctx);
      tlds = await acc.adapter.supportedTlds(acc.ctx);
      health = await acc.adapter.health(acc.ctx);
    } catch (e) {
      await this.audit.record({
        action: 'registrar.account.verified',
        actorUserId: adminUserId,
        outcome: 'failure',
        resource: { type: 'registrar_account', id: accountId },
        detail: { error: (e as Error).name },
      });
      throw new ProblemException(
        'service_unavailable',
        'the registrar account could not be probed (check the vault reference and the credentials)',
      );
    }
    const kinds = new Set<EvidenceKind>(probe.evidence.map((x: RawEvidence) => x.kind));
    const evidenceKind: EvidenceKind = kinds.has('mock')
      ? 'mock'
      : kinds.has('fixture')
        ? 'fixture'
        : kinds.has('live')
          ? 'live'
          : 'mock';
    const usable =
      isSupported(probe.capabilities, 'registrar.search') &&
      isSupported(probe.capabilities, 'registrar.register');
    if (enable) {
      if (!usable)
        throw new ProblemException(
          'unsupported_capability',
          'the probe did not show search and register as supported',
        );
      if (evidenceKind !== 'live' && !this.cfg.allowNonLiveRegistrars)
        throw new ProblemException(
          'unsupported_capability',
          `a registrar account with ${evidenceKind} evidence cannot be enabled in this profile (NOT VERIFIED; HG-07-01 needs live sandbox evidence)`,
        );
    }
    await this.db.withPlatformScope(async (c) => {
      await c.query(
        `UPDATE domains.registrar_accounts SET capabilities = $2, tld_support = $3, evidence_kind = $4, probed_at = now(), health = $5, updated_at = now()
          ${enable ? ', enabled = true' : ''} WHERE id = $1`,
        [
          accountId,
          JSON.stringify(probe.capabilities),
          JSON.stringify(tlds),
          evidenceKind,
          health.state,
        ],
      );
      if (enable)
        await c.query(
          `UPDATE domains.registrars SET enabled = true, updated_at = now() WHERE id = $1`,
          [account.registrarId],
        );
    });
    await this.audit.record({
      action: 'registrar.account.verified',
      actorUserId: adminUserId,
      outcome: 'success',
      resource: { type: 'registrar_account', id: accountId },
      detail: {
        providerCode: account.providerCode,
        evidenceKind,
        health: health.state,
        tlds: tlds.length,
        enabled: enable,
        supported: Object.entries(probe.capabilities).filter(([, v]) => v === 'supported').length,
      },
    });
    return {
      account: dto((await this.access.getAccount(accountId))!),
      capabilities: probe.capabilities,
      evidenceKind,
      evidenceCount: probe.evidence.length,
      tlds: tlds.length,
    };
  }
}
