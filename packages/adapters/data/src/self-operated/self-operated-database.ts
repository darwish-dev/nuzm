import {
  DATABASE_CAPABILITIES,
  completeCapabilities,
  type DatabaseCapabilityId,
} from '../contracts/capabilities';
import type {
  BackupRef,
  InstanceInspection,
  IntegrityReport,
  IssuedSecret,
} from '../contracts/common';
import type {
  CredentialRequest,
  DatabaseAdapter,
  DatabaseRef,
  DatabaseSpec,
  DatabaseUsage,
} from '../contracts/database';
import {
  idempotencyToken as tokenOf,
  isVaultRef,
  normalizedError,
  type AccountContext,
  type CapabilityState,
  type ComputePort,
  type DataCatalogSnapshot,
  type HealthReport,
  type OperationResult,
  type VaultClient,
} from '../upstream';
import { signCommand, type AgentCommand } from './agent-protocol';
import type { NodeAgentPort } from './fake-node';
import type { Clock } from '../mock/core';

export interface SelfOperatedConfig {
  /** Provider region ids of VERIFIED compute (from the M05 registry); anything else is refused. */
  regions: { providerRegionId: string; countryCode: string; verifiedAt: string | null }[];
  /** Plan refs offered and the compute plan each maps to. Config, not code. */
  plans: { planRef: string; computePlanRef: string; storageGb: number }[];
  imageRef: string;
  /** Supported majors per engine (config, not code). */
  versions: Record<'postgresql' | 'mysql', string[]>;
  /** The system bucket for base backups and WAL/binlog archive, per provider region (same data_region as the instance). */
  systemBucketFor(providerRegionId: string): string;
  /** `vault://` reference of the HMAC key shared with the node agents. */
  agentKeyRef: string;
  /** Capabilities the family declares; anything not listed is `unknown` (= unsupported). */
  capabilities?: Partial<Record<DatabaseCapabilityId, CapabilityState>>;
}

const ENGINE_CAP = (e: string) => `database.engine.${e}` as DatabaseCapabilityId;

/**
 * `self-operated-database` family (docs/09 §5, D-05 option B): Nuzm runs PostgreSQL/MySQL on compute obtained through the M05 `ComputeAdapter`
 * (here: `ComputePort`) and configures it ONLY through the signed, allow-listed agent protocol (agent-protocol.ts). TLS is required, there is no
 * public listener unless an allow-list is given, base backups + WAL/binlog archive go to a system bucket in the SAME provider region (data_region),
 * patching is an agent command with a policy. Resize is `unsupported` until a probe proves it. Capabilities are config; nothing is claimed for a vendor.
 * Every mutating step is idempotent per token and a failure after the compute side effect is `uncertain` (the reconciler decides).
 */
export class SelfOperatedDatabaseAdapter implements DatabaseAdapter {
  readonly id = 'self-operated-database';
  readonly kind = 'database' as const;
  readonly contractVersion = '1.0.0';
  private overrides: Partial<Record<DatabaseCapabilityId, CapabilityState>> = {};
  constructor(
    private readonly compute: ComputePort,
    private readonly agent: NodeAgentPort,
    private readonly vault: VaultClient,
    private readonly clock: Clock,
    private readonly cfg: SelfOperatedConfig,
  ) {
    if (!isVaultRef(cfg.agentKeyRef)) throw new Error('agentKeyRef must be a vault:// reference');
  }
  /** Test/probe control: capabilities as the account's probe reported them. */
  setCapabilities(p: Partial<Record<DatabaseCapabilityId, CapabilityState>>) {
    this.overrides = { ...this.overrides, ...p };
  }
  private cap(id: DatabaseCapabilityId): CapabilityState {
    return this.overrides[id] ?? this.cfg.capabilities?.[id] ?? 'unknown';
  }
  private sup(id: DatabaseCapabilityId) {
    return this.cap(id) === 'supported';
  }
  private iso() {
    return new Date(this.clock.now()).toISOString();
  }
  private ev(op: string, summary: string) {
    return { kind: 'mock' as const, capturedAt: this.iso(), operation: op, summary };
  }
  private bad<T>(
    op: string,
    cat: 'unsupported' | 'validation' | 'not_found' | 'conflict' | 'provider_outage',
    code: string,
    msg: string,
    retryable?: boolean,
  ): OperationResult<T> {
    return {
      status: 'failed',
      error: normalizedError(cat, code, msg, retryable),
      raw: this.ev(op, `${code}: ${msg}`),
    };
  }
  private ok<T>(
    op: string,
    summary: string,
    data?: T,
    providerRef?: string,
    status: 'succeeded' | 'accepted' = 'succeeded',
  ): OperationResult<T> {
    return { status, data, providerRef, raw: this.ev(op, summary) };
  }
  private unc<T>(op: string, why: string): OperationResult<T> {
    return {
      status: 'uncertain',
      error: normalizedError('provider_outage', 'PARTIAL', why, true),
      raw: this.ev(op, `uncertain: ${why}`),
    };
  }

  async probe(_ctx: AccountContext) {
    return {
      capabilities: completeCapabilities(DATABASE_CAPABILITIES, {
        ...this.cfg.capabilities,
        ...this.overrides,
      }),
      evidence: [
        this.ev(
          'probe',
          'self-operated family: capabilities are declared configuration plus what the agent reports; NOT a vendor claim',
        ),
      ],
      probedAt: this.iso(),
    };
  }
  async health(_ctx: AccountContext): Promise<HealthReport> {
    return {
      state: 'unknown',
      checkedAt: this.iso(),
      detail: 'fleet health is reported by the agents',
      evidence: [this.ev('health', 'no probe')],
    };
  }
  async catalog(_ctx: AccountContext): Promise<DataCatalogSnapshot> {
    return {
      takenAt: this.iso(),
      // a region is "verified" only through the M05 registry; this family just forwards what it was configured with
      regions: this.cfg.regions.map((r) => ({
        providerRegionId: r.providerRegionId,
        countryCode: r.countryCode,
        verifiedAt: r.verifiedAt,
        evidence: [this.ev('catalog', 'configured region')],
      })),
      plans: this.cfg.plans.map((p) => ({
        planRef: p.planRef,
        providerRegionId: null,
        attributes: { storageGb: p.storageGb, engines: 'postgresql,mysql' },
        availability: 'available' as const,
      })),
      evidence: [
        this.ev(
          'catalog',
          'configured catalog; no provider price (own compute cost comes from M05)',
        ),
      ],
    };
  }

  private async key(): Promise<Uint8Array> {
    const m = await this.vault.resolve(this.cfg.agentKeyRef);
    const k = m.fields.key;
    if (!k) throw new Error('agent key missing in vault');
    return Buffer.from(k, 'hex');
  }
  private async cmd(ref: string, cmd: AgentCommand, args: Record<string, unknown>) {
    const c = signCommand(await this.key(), ref, cmd, args, this.clock.now());
    return this.agent.execute(ref, c);
  }
  private async inspectCompute(ctx: AccountContext, ref: string) {
    return this.compute.inspect(ctx, ref);
  }

  async create(
    ctx: AccountContext,
    req: DatabaseSpec & { idempotencyToken: string },
  ): Promise<OperationResult<DatabaseRef>> {
    if (!this.sup(ENGINE_CAP(req.engine)))
      return this.bad(
        'create',
        'unsupported',
        'UNSUPPORTED',
        `engine ${req.engine} is not supported`,
      );
    if (!this.sup('database.provision'))
      return this.bad('create', 'unsupported', 'UNSUPPORTED', 'provisioning is not supported');
    if (!this.cfg.versions[req.engine]?.includes(req.version))
      return this.bad(
        'create',
        'validation',
        'VERSION',
        `version ${req.version} is not in the supported list`,
      );
    const region = this.cfg.regions.find((r) => r.providerRegionId === req.providerRegionId);
    if (!region) return this.bad('create', 'validation', 'REGION', 'unknown provider region');
    const plan = this.cfg.plans.find((p) => p.planRef === req.planRef);
    if (!plan) return this.bad('create', 'validation', 'PLAN', 'unknown plan');
    const p = await this.compute.provision(ctx, {
      providerRegionId: req.providerRegionId,
      planRef: plan.computePlanRef,
      imageRef: this.cfg.imageRef,
      name: req.name,
      diskGb: req.storageGb,
      sshPublicKeys: [],
      tags: { ...req.tags, 'nuzm-role': 'database' },
      idempotencyToken: req.idempotencyToken,
    });
    if (p.status === 'failed') return { ...p, data: undefined };
    if (p.status === 'uncertain') return this.unc('create', 'the compute call timed out');
    const ref = p.providerRef ?? p.data!.providerRef;
    const boot = await this.cmd(ref, 'bootstrap', {
      engine: req.engine,
      version: req.version,
      listen: req.network.access === 'private' ? 'private' : 'allowlist',
      ...(req.network.allowCidrs ? { allowCidrs: req.network.allowCidrs } : {}),
      tlsRequired: true,
      archiveBucket: this.cfg.systemBucketFor(req.providerRegionId),
      dataRegion: req.providerRegionId,
    });
    // the node exists; if it could not be configured the result is uncertain: replaying `create` with the same token re-sends the (idempotent) bootstrap
    if (!boot.ok) return this.unc('create', `node created but not configured: ${boot.refusal}`);
    return this.ok(
      'create',
      'node provisioned and bootstrapped',
      { providerRef: ref },
      ref,
      'accepted',
    );
  }

  async inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceInspection>> {
    const c = await this.inspectCompute(ctx, ref);
    if (c.status !== 'succeeded' && c.status !== 'accepted')
      return { ...c, data: undefined } as OperationResult<InstanceInspection>;
    const s = c.data!;
    if (s.status === 'deleted')
      return this.ok(
        'inspect',
        'deleted',
        {
          providerRef: ref,
          status: 'deleted',
          engine: '',
          version: '',
          endpoint: null,
          tlsRequired: true,
          providerRegionId: s.providerRegionId,
          planRef: s.planRef,
          storageGb: 0,
          network: { access: 'private' },
          tags: s.tags,
          observedAt: this.iso(),
        },
        ref,
      );
    const st = await this.cmd(ref, 'status', {});
    if (!st.ok)
      return this.bad('inspect', 'provider_outage', 'AGENT', `agent: ${st.refusal}`, st.retryable);
    const r = st.result as {
      bootstrapped: boolean;
      engine: string | null;
      version: string | null;
      listen: 'private' | 'allowlist' | null;
      tls: boolean;
      port: number;
    };
    const host = s.privateIps?.[0] ?? s.publicIps[0] ?? null;
    return this.ok(
      'inspect',
      'inspected',
      {
        providerRef: ref,
        status: r.bootstrapped ? 'running' : 'provisioning',
        engine: r.engine ?? '',
        version: r.version ?? '',
        endpoint: host && r.bootstrapped ? { host, port: r.port } : null,
        tlsRequired: r.tls,
        providerRegionId: s.providerRegionId,
        planRef: s.planRef,
        storageGb: this.cfg.plans.find((p) => p.computePlanRef === s.planRef)?.storageGb ?? 0,
        network: { access: r.listen === 'allowlist' ? 'allowlist' : 'private' },
        tags: s.tags,
        observedAt: this.iso(),
      },
      ref,
    );
  }
  async findByToken(
    ctx: AccountContext,
    token: string,
  ): Promise<OperationResult<DatabaseRef | null>> {
    const f = await this.compute.findByToken(ctx, token);
    return f.status === 'succeeded' || f.status === 'accepted'
      ? this.ok(
          'findByToken',
          f.data ? 'found' : 'absent',
          f.data ? { providerRef: f.data.providerRef } : null,
          f.data?.providerRef,
        )
      : ({ ...f, data: undefined } as OperationResult<DatabaseRef | null>);
  }
  async delete(
    ctx: AccountContext,
    ref: string,
    _o: { idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    // the retention of backups is the orchestrator's decision (it takes the final backup first); this destroys the node
    const r = await this.compute.delete(ctx, ref);
    return r.status === 'succeeded' || r.status === 'accepted'
      ? this.ok('delete', 'deleted')
      : (r as OperationResult<void>);
  }
  /** Not offered: a resize needs a verified procedure (storage grow + restart). Capability stays `unknown` until a probe proves it. */
  async resize(
    _ctx: AccountContext,
    _ref: string,
    _c: { planRef?: string; storageGb?: number; idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    return this.bad(
      'resize',
      'unsupported',
      'UNSUPPORTED',
      'resize is not supported by this family yet',
    );
  }

  async backup(
    _ctx: AccountContext,
    ref: string,
    req: { type: BackupRef['type']; idempotencyToken: string },
  ): Promise<OperationResult<BackupRef>> {
    if (!this.sup('database.backup'))
      return this.bad('backup', 'unsupported', 'UNSUPPORTED', 'backups are not supported');
    const id = `bk-${tokenOf('self-operated', ref, req.idempotencyToken).slice(0, 12)}`;
    const r = await this.cmd(ref, 'base_backup', { backupId: id, kind: req.type });
    if (!r.ok)
      return r.retryable
        ? this.unc('backup', r.refusal)
        : this.bad('backup', 'not_found', r.refusal.toUpperCase(), r.refusal);
    return this.ok(
      'backup',
      'base backup archived',
      (r.result as { backup: BackupRef }).backup,
      id,
    );
  }
  async listBackups(_ctx: AccountContext, ref: string): Promise<OperationResult<BackupRef[]>> {
    const r = await this.cmd(ref, 'list_backups', {});
    return r.ok
      ? this.ok('listBackups', 'listed', (r.result as { backups: BackupRef[] }).backups)
      : this.bad('listBackups', 'provider_outage', 'AGENT', r.refusal, true);
  }
  async findBackupByToken(
    ctx: AccountContext,
    ref: string,
    token: string,
  ): Promise<OperationResult<BackupRef | null>> {
    const id = `bk-${tokenOf('self-operated', ref, token).slice(0, 12)}`;
    const l = await this.listBackups(ctx, ref);
    if (l.status !== 'succeeded')
      return { ...l, data: undefined } as OperationResult<BackupRef | null>;
    return this.ok(
      'findBackupByToken',
      'looked up',
      l.data!.find((b) => b.backupRef === id) ?? null,
    );
  }
  async deleteBackup(
    _ctx: AccountContext,
    _ref: string,
    _b: string,
  ): Promise<OperationResult<void>> {
    return this.ok(
      'deleteBackup',
      'artifact removal is the retention job (system bucket lifecycle)',
    );
  }
  async restoreToNew(
    ctx: AccountContext,
    req: {
      sourceRef: string;
      backupRef: string;
      target: Omit<DatabaseSpec, 'engine' | 'version'>;
      idempotencyToken: string;
    },
  ): Promise<OperationResult<DatabaseRef>> {
    if (!this.sup('database.restore-to-new'))
      return this.bad(
        'restoreToNew',
        'unsupported',
        'UNSUPPORTED',
        'restore-to-new is not supported',
      );
    const src = await this.inspect(ctx, req.sourceRef);
    if (src.status !== 'succeeded' && src.status !== 'accepted')
      return { ...src, data: undefined } as OperationResult<DatabaseRef>;
    if (req.target.providerRegionId !== src.data!.providerRegionId)
      return this.bad(
        'restoreToNew',
        'validation',
        'CROSS_REGION',
        'restore stays in the source provider region',
      );
    const plan = this.cfg.plans.find((p) => p.planRef === req.target.planRef);
    if (!plan) return this.bad('restoreToNew', 'validation', 'PLAN', 'unknown plan');
    const p = await this.compute.provision(ctx, {
      providerRegionId: req.target.providerRegionId,
      planRef: plan.computePlanRef,
      imageRef: this.cfg.imageRef,
      name: req.target.name,
      diskGb: req.target.storageGb,
      sshPublicKeys: [],
      tags: { ...req.target.tags, 'nuzm-role': 'database' },
      idempotencyToken: req.idempotencyToken,
    });
    if (p.status === 'failed') return { ...p, data: undefined };
    if (p.status === 'uncertain') return this.unc('restoreToNew', 'the compute call timed out');
    const ref = p.providerRef ?? p.data!.providerRef;
    const boot = await this.cmd(ref, 'bootstrap', {
      engine: src.data!.engine,
      version: src.data!.version,
      listen: req.target.network.access === 'private' ? 'private' : 'allowlist',
      tlsRequired: true,
      archiveBucket: this.cfg.systemBucketFor(req.target.providerRegionId),
      dataRegion: req.target.providerRegionId,
    });
    if (!boot.ok)
      return this.unc('restoreToNew', `node created but not configured: ${boot.refusal}`);
    const rest = await this.cmd(ref, 'restore_new', {
      backupId: req.backupRef,
      sourceNodeRef: req.sourceRef,
    });
    if (!rest.ok)
      return rest.retryable
        ? this.unc('restoreToNew', rest.refusal)
        : this.bad('restoreToNew', 'not_found', 'NO_BACKUP', rest.refusal);
    return this.ok(
      'restoreToNew',
      'restored into a new node',
      { providerRef: ref },
      ref,
      'accepted',
    );
  }
  async restoreInPlace(
    _ctx: AccountContext,
    ref: string,
    backupRef: string,
    _o: { idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    if (!this.sup('database.restore-in-place'))
      return this.bad(
        'restoreInPlace',
        'unsupported',
        'UNSUPPORTED',
        'in-place restore is not supported',
      );
    const r = await this.cmd(ref, 'restore_in_place', { backupId: backupRef });
    return r.ok
      ? this.ok('restoreInPlace', 'restored in place')
      : this.bad('restoreInPlace', 'not_found', 'NO_BACKUP', r.refusal);
  }
  async issueCredential(
    _ctx: AccountContext,
    ref: string,
    req: CredentialRequest & { keepPrevious: boolean },
  ): Promise<OperationResult<IssuedSecret>> {
    if (!this.sup('database.credential-rotation'))
      return this.bad(
        'issueCredential',
        'unsupported',
        'UNSUPPORTED',
        'credential issuing is not supported',
      );
    if (req.keepPrevious && !this.sup('database.dual-credentials'))
      return this.bad(
        'issueCredential',
        'unsupported',
        'UNSUPPORTED',
        'dual credentials are not supported',
      );
    const credentialId = `cred-${tokenOf('self-operated', ref, req.idempotencyToken).slice(0, 12)}`;
    const r = await this.cmd(ref, 'create_role', {
      role: req.role,
      credentialId,
      keepPrevious: req.keepPrevious,
    });
    if (!r.ok)
      return r.retryable
        ? this.unc('issueCredential', r.refusal)
        : this.bad('issueCredential', 'validation', 'REFUSED', r.refusal);
    // the secret travels back in `data` only; evidence (`raw`) is built here and never contains it
    return this.ok('issueCredential', 'role created', {
      credentialId,
      username: `u_${req.role}_${credentialId.slice(5, 11)}`,
      fields: { password: (r.result as { password: string }).password },
    });
  }
  async revokeCredential(
    _ctx: AccountContext,
    ref: string,
    req: { credentialId: string; idempotencyToken: string },
  ): Promise<OperationResult<void>> {
    const r = await this.cmd(ref, 'drop_role', { credentialId: req.credentialId });
    return r.ok
      ? this.ok('revokeCredential', 'role dropped')
      : r.retryable
        ? this.unc('revokeCredential', r.refusal)
        : this.bad('revokeCredential', 'validation', 'REFUSED', r.refusal);
  }
  async listCredentials(
    _ctx: AccountContext,
    ref: string,
  ): Promise<OperationResult<{ credentialId: string; role: string }[]>> {
    const r = await this.cmd(ref, 'list_roles', {});
    return r.ok
      ? this.ok(
          'listCredentials',
          'listed',
          (r.result as { roles: { credentialId: string; role: string }[] }).roles,
        )
      : this.bad('listCredentials', 'provider_outage', 'AGENT', r.refusal, true);
  }
  async integrityCheck(
    _ctx: AccountContext,
    ref: string,
    o: { sampleTables: number },
  ): Promise<OperationResult<IntegrityReport>> {
    if (!this.sup('database.integrity-check'))
      return this.bad(
        'integrityCheck',
        'unsupported',
        'UNSUPPORTED',
        'integrity check is not supported',
      );
    const r = await this.cmd(ref, 'integrity_check', {
      sampleTables: Math.min(Math.max(o.sampleTables, 1), 1000),
    });
    if (!r.ok) return this.bad('integrityCheck', 'not_found', 'REFUSED', r.refusal);
    const x = r.result as {
      engineCheck: IntegrityReport['engineCheck'];
      tables: IntegrityReport['tables'];
    };
    return this.ok('integrityCheck', 'checked', {
      engineCheck: x.engineCheck,
      tables: x.tables,
      checkedAt: this.iso(),
    });
  }
  async usage(_ctx: AccountContext, ref: string): Promise<OperationResult<DatabaseUsage>> {
    if (!this.sup('database.usage'))
      return this.bad('usage', 'unsupported', 'UNSUPPORTED', 'usage reporting is not supported');
    const r = await this.cmd(ref, 'usage', {});
    return r.ok
      ? this.ok('usage', 'usage', r.result as unknown as DatabaseUsage)
      : this.bad('usage', 'provider_outage', 'AGENT', r.refusal, true);
  }
  /** Patch policy hook (minor/security) — an agent command, not a shell. */
  async patch(ref: string, policy: 'minor' | 'security'): Promise<OperationResult<void>> {
    const r = await this.cmd(ref, 'apply_patch', { policy });
    return r.ok
      ? this.ok('patch', 'patched')
      : this.bad('patch', 'provider_outage', 'AGENT', r.refusal, true);
  }
}
