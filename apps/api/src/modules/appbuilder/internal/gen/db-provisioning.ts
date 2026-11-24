import { createHash, randomBytes } from 'node:crypto';
import { scanForSecrets } from '@nuzm/domain';

/**
 * P3-S05 database provisioning for GENERATED apps (acceptance F3). Design: `docs/phase3/design/P3-S05-app-database.md`.
 *
 * Two modes, one rule: the generated app gets a database of its own and NO credential of the platform.
 *
 *  - `in-sandbox` (run-and-probe, T2 proof): the database is created INSIDE the workspace by the platform-owned probe (`probe/pg-sandbox.ts`): a throw-away PostgreSQL on 127.0.0.1 with random credentials
 *    generated in the sandbox, destroyed with the workspace. The platform never sees or stores a password; this module only PLANS the run and VERIFIES the isolation evidence the probe returns.
 *  - `managed` (staging deployment, decision B-DB): a database + role per deployment on a managed PostgreSQL, created through `ManagedDatabasePort`. The generated password never leaves the vault: the port
 *    writes it straight to the vault (`SecretVaultPort`) and this service only handles the vault REFERENCE. The app environment is built from references (`vault://…`), never from values.
 *
 * Money/idempotency/durability rules of the platform apply: the create call is idempotent per (org, workspace, purpose), an uncertain result is RECONCILED before any retry, destruction is tied to the
 * workspace and an orphan sweeper removes what no live workspace owns. Every method is tenant-scoped (a record of another organisation is `not_found`). All provider I/O goes through ports (D-AG adapters);
 * `SimulatedManagedDatabase` is the only implementation here and its results are labelled SIMULATED.
 */

// ---------------------------------------------------------------------------------------------------- environment guard
/** The only variables a generated app receives. Anything else is refused: the app's environment is NOT the platform's environment. */
export const APP_ENV_ALLOWLIST = [
  'PORT',
  'STORE',
  'DATABASE_URL',
  'SESSION_SECRET',
  'NODE_ENV',
  'NOTIFY_URL',
  'NOTIFY_TOKEN',
] as const;
const SECRET_BEARING = new Set(['DATABASE_URL', 'SESSION_SECRET', 'NOTIFY_TOKEN']);
const VAULT_REF = /^vault:\/\/orgs\/[0-9a-f-]{36}\/apps\/[A-Za-z0-9_-]{1,64}\/[a-z0-9/_-]{1,80}$/;

export interface EnvGuardInput {
  env: Readonly<Record<string, string>>;
  /** `references`: secret-bearing variables must be vault references (managed mode). `generated`: they were created inside the sandbox (in-sandbox mode). */
  mode: 'references' | 'generated';
  /** Hosts and ports of platform databases/services the app must never reach (from the platform configuration). */
  platformHosts?: readonly string[];
  /** Exact secret values of the platform (and planted canaries): none may appear anywhere in the environment. */
  platformSecrets?: readonly string[];
}
export interface EnvGuardResult {
  ok: boolean;
  reasons: string[];
}
export function checkAppEnvironment(i: EnvGuardInput): EnvGuardResult {
  const reasons = new Set<string>();
  for (const [k, v] of Object.entries(i.env)) {
    if (!(APP_ENV_ALLOWLIST as readonly string[]).includes(k)) reasons.add('env_name_not_allowed');
    if (typeof v !== 'string') {
      reasons.add('env_value_not_string');
      continue;
    }
    for (const s of i.platformSecrets ?? [])
      if (s.length >= 8 && v.includes(s)) reasons.add('env_contains_platform_secret');
    for (const h of i.platformHosts ?? [])
      if (h.length > 0 && v.toLowerCase().includes(h.toLowerCase()))
        reasons.add('env_points_at_platform_host');
    if (i.mode === 'references' && SECRET_BEARING.has(k) && !VAULT_REF.test(v))
      reasons.add('env_secret_not_a_vault_reference');
    if (i.mode === 'references' && !SECRET_BEARING.has(k) && scanForSecrets(`${k}=${v}`).length > 0)
      reasons.add('env_value_looks_like_secret');
  }
  if (!('DATABASE_URL' in i.env) && i.env['STORE'] !== 'memory')
    reasons.add('env_database_url_missing');
  return { ok: reasons.size === 0, reasons: [...reasons].sort() };
}

// ---------------------------------------------------------------------------------------------------- in-sandbox mode
/** Result block of the in-sandbox probe (`isolation` of probe-report.json), produced by platform-owned code inside the runtime. */
export interface SandboxIsolationEvidence {
  inheritedEnvNames?: string[];
  databaseHost?: string;
  databaseRole?: string;
  roleSuperuser?: boolean;
  roleBypassRls?: boolean;
  migrationsApplied?: number;
  migrationsReapplied?: number;
  databaseDestroyed?: boolean;
}
export interface IsolationVerdict {
  ok: boolean;
  checks: { id: string; ok: boolean }[];
}
/** What the platform requires of a run's isolation evidence before it counts a T2 run (F3 + F4). The verdict is derived from the evidence only; it is `SIMULATED` unless the run itself was LIVE-VERIFIED. */
export function verifySandboxIsolation(
  e: SandboxIsolationEvidence | undefined,
  o: { multiTenant: boolean },
): IsolationVerdict {
  const checks: { id: string; ok: boolean }[] = [
    {
      id: 'no_platform_env_inherited',
      ok: Array.isArray(e?.inheritedEnvNames) && e.inheritedEnvNames.length === 0,
    },
    { id: 'database_on_loopback', ok: e?.databaseHost === '127.0.0.1' },
    { id: 'role_not_superuser', ok: e?.roleSuperuser === false },
    { id: 'role_does_not_bypass_rls', ok: e?.roleBypassRls === false },
    { id: 'migrations_applied', ok: (e?.migrationsApplied ?? 0) >= 1 },
    { id: 'migrations_rerunnable', ok: e?.migrationsReapplied === 0 },
    { id: 'database_destroyed', ok: e?.databaseDestroyed === true },
  ];
  void o.multiTenant; // the role/RLS checks apply to every app; kept for the evidence shape of multi-tenant runs
  return { ok: checks.every((c) => c.ok), checks };
}

/** The request the loop sends to the qualified runtime for a probe run. The platform names a profile; it never supplies a command line, a credential or an environment (docs/phase3, S02 contract). */
export interface ProbeRunRequest {
  profile: 'app-probe';
  /** the workspace holds the generated project (with the platform-owned probe files) */
  workspaceId: string;
  network: 'loopback-only';
  limits: { wallSeconds: number; memoryMb: number; diskMb: number; pids: number };
  env: Record<string, never>;
  /** the runtime must destroy the workspace (and with it the ephemeral database) when the run ends */
  destroyWorkspaceOnExit: true;
}
export function planProbeRun(workspaceId: string): ProbeRunRequest {
  return {
    profile: 'app-probe',
    workspaceId,
    network: 'loopback-only',
    limits: { wallSeconds: 300, memoryMb: 2048, diskMb: 1024, pids: 256 },
    env: {},
    destroyWorkspaceOnExit: true,
  };
}

// ---------------------------------------------------------------------------------------------------- managed mode (staging)
export interface DatabaseNames {
  database: string;
  role: string;
}
export interface ManagedDatabasePort {
  /** Creates database + role and writes the generated password to the vault at `passwordRef`. Idempotent per `idempotencyKey`. Returns no secret. */
  create(i: {
    idempotencyKey: string;
    names: DatabaseNames;
    region: string;
    passwordRef: string;
    tags: Record<string, string>;
  }): Promise<{ host: string; port: number }>;
  /** Drops the database and the role. Idempotent. */
  destroy(i: { names: DatabaseNames }): Promise<void>;
  /** What exists on the instance for the tag (used to reconcile an uncertain create and to sweep orphans). */
  list(tag: {
    key: string;
    value: string;
  }): Promise<{ names: DatabaseNames; tags: Record<string, string> }[]>;
}
export interface SecretVaultPort {
  /** Registers that a secret exists at `ref` (the VALUE is written by the database port, never by the platform). */
  exists(ref: string): Promise<boolean>;
  remove(ref: string): Promise<void>;
}
export type DbState = 'requested' | 'creating' | 'ready' | 'destroying' | 'destroyed' | 'failed';
export interface DbRecord {
  id: string;
  orgId: string;
  workspaceId: string;
  purpose: 'staging' | 'preview';
  region: string;
  names: DatabaseNames;
  passwordRef: string;
  host: string | null;
  port: number | null;
  state: DbState;
  idempotencyKey: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DbLedger {
  byKey(orgId: string, key: string): Promise<DbRecord | null>;
  get(orgId: string, id: string): Promise<DbRecord | null>;
  byWorkspace(orgId: string, workspaceId: string): Promise<DbRecord[]>;
  put(r: DbRecord): Promise<void>;
  all(): Promise<DbRecord[]>;
}
export class MemoryDbLedger implements DbLedger {
  private rows = new Map<string, DbRecord>();
  async byKey(orgId: string, key: string) {
    return (
      [...this.rows.values()].find((r) => r.orgId === orgId && r.idempotencyKey === key) ?? null
    );
  }
  async get(orgId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.orgId === orgId ? { ...r } : null;
  }
  async byWorkspace(orgId: string, workspaceId: string) {
    return [...this.rows.values()]
      .filter((r) => r.orgId === orgId && r.workspaceId === workspaceId)
      .map((r) => ({ ...r }));
  }
  async put(r: DbRecord) {
    this.rows.set(r.id, { ...r });
  }
  async all() {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
}
export interface AuditSink {
  record(e: {
    action: string;
    orgId: string;
    resource: string;
    detail: Record<string, unknown>;
  }): void;
}
export interface DbProvisionerDeps {
  port: ManagedDatabasePort;
  vault: SecretVaultPort;
  ledger: DbLedger;
  audit?: AuditSink;
  /** `ResidencyPolicyService` stand-in: returns false when a database may not be placed in `region` for the organisation. */
  residencyAllows: (orgId: string, region: string) => boolean | Promise<boolean>;
  now?: () => Date;
  newId?: () => string;
  /** Platform database hosts and secret values the app environment must never contain (see `checkAppEnvironment`). */
  platformHosts?: readonly string[];
  platformSecrets?: readonly string[];
}
export class ProvisionRefused extends Error {
  constructor(readonly reasons: string[]) {
    super('provisioning refused: ' + reasons.join(','));
    this.name = 'ProvisionRefused';
  }
}
/** Derives database and role names from ids only (never from user text): lowercase, bounded, unique per (org, workspace, purpose). */
export function deriveNames(orgId: string, workspaceId: string, purpose: string): DatabaseNames {
  const h = createHash('sha256').update(`${orgId}|${workspaceId}|${purpose}`).digest('hex');
  return { database: 'app_' + h.slice(0, 20), role: 'app_' + h.slice(20, 40) };
}
export const vaultRefFor = (orgId: string, projectId: string, what: string): string =>
  `vault://orgs/${orgId}/apps/${projectId}/${what}`;

export class AppDatabaseProvisioner {
  private now: () => Date;
  private newId: () => string;
  constructor(private d: DbProvisionerDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId =
      d.newId ??
      (() =>
        randomBytes(16)
          .toString('hex')
          .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'));
  }
  private stamp(r: DbRecord, patch: Partial<DbRecord>): DbRecord {
    return { ...r, ...patch, updatedAt: this.now().toISOString() };
  }
  /** Creates (or returns the existing) database of a workspace. Safe to call again after a timeout: an uncertain earlier attempt is reconciled against the instance before anything is created. */
  async provision(i: {
    orgId: string;
    projectId: string;
    workspaceId: string;
    purpose: 'staging' | 'preview';
    region: string;
  }): Promise<DbRecord> {
    const key = `${i.orgId}:${i.workspaceId}:${i.purpose}`;
    const existing = await this.d.ledger.byKey(i.orgId, key);
    if (existing && existing.state === 'ready') return existing;
    if (existing && (existing.state === 'creating' || existing.state === 'requested'))
      return this.reconcileOne(existing);
    if (!(await this.d.residencyAllows(i.orgId, i.region)))
      throw new ProvisionRefused(['residency_not_allowed']);
    const names = deriveNames(i.orgId, i.workspaceId, i.purpose);
    const passwordRef = vaultRefFor(i.orgId, i.projectId, `db/${names.role}`);
    const t = this.now().toISOString();
    let rec: DbRecord =
      existing && existing.state !== 'destroyed'
        ? this.stamp(existing, { state: 'creating', error: null })
        : {
            id: this.newId(),
            orgId: i.orgId,
            workspaceId: i.workspaceId,
            purpose: i.purpose,
            region: i.region,
            names,
            passwordRef,
            host: null,
            port: null,
            state: 'creating',
            idempotencyKey: existing ? key + ':' + this.newId() : key,
            error: null,
            createdAt: t,
            updatedAt: t,
          };
    await this.d.ledger.put(rec); // the intent is durable BEFORE the provider is called
    try {
      const r = await this.d.port.create({
        idempotencyKey: rec.idempotencyKey,
        names,
        region: i.region,
        passwordRef,
        tags: { 'nuzm-org': i.orgId, 'nuzm-workspace': i.workspaceId, 'nuzm-record': rec.id },
      });
      rec = this.stamp(rec, { state: 'ready', host: r.host, port: r.port });
      await this.d.ledger.put(rec);
      this.d.audit?.record({
        action: 'app_database.created',
        orgId: i.orgId,
        resource: rec.id,
        detail: { workspaceId: i.workspaceId, purpose: i.purpose, region: i.region },
      });
      return rec;
    } catch (e) {
      // uncertain: the instance may or may not have created it. Do NOT retry blindly: leave `creating`, the caller (or the sweeper) reconciles.
      rec = this.stamp(rec, { error: e instanceof Error ? e.message.slice(0, 200) : 'error' });
      await this.d.ledger.put(rec);
      throw e;
    }
  }
  /** Looks at the instance for the record's tag and settles the record: found => ready, not found => failed (safe to provision again). */
  async reconcileOne(rec: DbRecord): Promise<DbRecord> {
    const found = await this.d.port.list({ key: 'nuzm-record', value: rec.id });
    const there = found.some((f) => f.names.database === rec.names.database);
    const next =
      there && (await this.d.vault.exists(rec.passwordRef))
        ? this.stamp(rec, { state: 'ready', error: null })
        : this.stamp(rec, { state: 'failed', error: there ? 'secret_missing' : 'not_created' });
    if (there && next.state === 'failed') await this.d.port.destroy({ names: rec.names }); // a database without its secret is unusable: remove it
    await this.d.ledger.put(next);
    this.d.audit?.record({
      action: 'app_database.reconciled',
      orgId: rec.orgId,
      resource: rec.id,
      detail: { state: next.state },
    });
    return next;
  }
  /** The environment of the app: references only. Fails closed if anything about it is not allowed. */
  async environmentFor(
    orgId: string,
    recordId: string,
    o: { projectId: string; port: number },
  ): Promise<Record<string, string>> {
    const rec = await this.d.ledger.get(orgId, recordId);
    if (!rec) throw new ProvisionRefused(['not_found']); // also the answer for another organisation's record
    if (rec.state !== 'ready') throw new ProvisionRefused(['database_not_ready']);
    const env: Record<string, string> = {
      PORT: String(o.port),
      STORE: 'pg',
      NODE_ENV: 'production',
      // the vault resolves these at start, inside the target; the platform never holds the values
      DATABASE_URL: vaultRefFor(orgId, o.projectId, `db-url/${rec.names.role}`),
      SESSION_SECRET: vaultRefFor(orgId, o.projectId, 'session-secret'),
    };
    const g = checkAppEnvironment({
      env,
      mode: 'references',
      ...(this.d.platformHosts ? { platformHosts: this.d.platformHosts } : {}),
      ...(this.d.platformSecrets ? { platformSecrets: this.d.platformSecrets } : {}),
    });
    if (!g.ok) throw new ProvisionRefused(g.reasons);
    return env;
  }
  /** Destroys the database of a workspace together with its vault entries. Idempotent. */
  async destroyForWorkspace(orgId: string, workspaceId: string): Promise<number> {
    let n = 0;
    for (const r of await this.d.ledger.byWorkspace(orgId, workspaceId)) {
      if (r.state === 'destroyed') continue;
      await this.d.ledger.put(this.stamp(r, { state: 'destroying' }));
      await this.d.port.destroy({ names: r.names });
      await this.d.vault.remove(r.passwordRef);
      await this.d.ledger.put(this.stamp(r, { state: 'destroyed' }));
      this.d.audit?.record({
        action: 'app_database.destroyed',
        orgId,
        resource: r.id,
        detail: { workspaceId },
      });
      n++;
    }
    return n;
  }
  /**
   * Orphan sweep: every database of ours on the instance (found by tag) whose workspace is not live is destroyed; every non-destroyed record whose database is gone is settled.
   * `liveWorkspaces` comes from the workspace service. Returns what it did, for the reconciler metric.
   */
  async sweep(
    liveWorkspaces: ReadonlySet<string>,
  ): Promise<{ destroyed: number; settled: number }> {
    let destroyed = 0;
    let settled = 0;
    for (const r of await this.d.ledger.all()) {
      if (r.state === 'destroyed') continue;
      if (!liveWorkspaces.has(r.workspaceId)) {
        await this.destroyForWorkspace(r.orgId, r.workspaceId);
        destroyed++;
      } else if (r.state === 'creating') {
        await this.reconcileOne(r);
        settled++;
      }
    }
    // databases that exist on the instance with no ledger record at all (a crash between create and put): destroyed
    const known = new Set((await this.d.ledger.all()).map((r) => r.names.database));
    for (const f of await this.d.port.list({ key: 'nuzm-org', value: '' }).catch(() => [])) {
      if (!known.has(f.names.database)) {
        await this.d.port.destroy({ names: f.names });
        destroyed++;
      }
    }
    return { destroyed, settled };
  }
}

// ---------------------------------------------------------------------------------------------------- simulated port
/** In-memory stand-in for the managed PostgreSQL + vault. SIMULATED: it proves the orchestration (idempotency, reconcile, isolation, destruction), not any real database. */
export class SimulatedManagedDatabase implements ManagedDatabasePort, SecretVaultPort {
  readonly label = 'SIMULATED' as const;
  databases = new Map<
    string,
    { names: DatabaseNames; tags: Record<string, string>; region: string }
  >();
  secrets = new Set<string>();
  calls: string[] = [];
  /** fault injection: `ambiguous` = the instance creates the database but the caller sees a timeout */
  failNextCreate: 'none' | 'ambiguous' | 'clean' = 'none';
  async create(
    i: Parameters<ManagedDatabasePort['create']>[0],
  ): Promise<{ host: string; port: number }> {
    this.calls.push('create');
    if (this.failNextCreate === 'clean') {
      this.failNextCreate = 'none';
      throw new Error('provider unavailable');
    }
    if (!this.databases.has(i.names.database)) {
      this.databases.set(i.names.database, { names: i.names, tags: i.tags, region: i.region });
      this.secrets.add(i.passwordRef); // written by the "provider" straight into the vault: the caller never gets a value
    }
    if (this.failNextCreate === 'ambiguous') {
      this.failNextCreate = 'none';
      throw new Error('timeout');
    }
    return { host: 'db.simulated.internal', port: 5432 };
  }
  async destroy(i: { names: DatabaseNames }): Promise<void> {
    this.calls.push('destroy');
    this.databases.delete(i.names.database);
  }
  async list(tag: { key: string; value: string }) {
    return [...this.databases.values()]
      .filter((d) => (tag.value === '' ? tag.key in d.tags : d.tags[tag.key] === tag.value))
      .map((d) => ({ names: d.names, tags: d.tags }));
  }
  async exists(ref: string): Promise<boolean> {
    return this.secrets.has(ref);
  }
  async remove(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }
}
