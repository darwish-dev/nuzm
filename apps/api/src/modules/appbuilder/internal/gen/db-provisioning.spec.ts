import { describe, expect, it } from 'vitest';
import {
  AppDatabaseProvisioner,
  checkAppEnvironment,
  deriveNames,
  MemoryDbLedger,
  planProbeRun,
  ProvisionRefused,
  SimulatedManagedDatabase,
  verifySandboxIsolation,
  vaultRefFor,
} from './db-provisioning';

const ORG_A = '0192f6a0-0000-7000-8000-00000000000a';
const ORG_B = '0192f6a0-0000-7000-8000-00000000000b';
const setup = (over: { allow?: boolean } = {}) => {
  const sim = new SimulatedManagedDatabase();
  const ledger = new MemoryDbLedger();
  const events: string[] = [];
  let n = 0;
  const p = new AppDatabaseProvisioner({
    port: sim,
    vault: sim,
    ledger,
    audit: { record: (e) => events.push(e.action) },
    residencyAllows: () => over.allow ?? true,
    platformHosts: ['platform-db.internal', '10.0.0.5'],
    platformSecrets: ['PLATFORM-SECRET-VALUE-0123456789'],
    newId: () => `0192f6a0-0000-7000-8000-${String(++n).padStart(12, '0')}`,
  });
  return { sim, ledger, events, p };
};
const req = (o: Partial<Parameters<AppDatabaseProvisioner['provision']>[0]> = {}) => ({
  orgId: ORG_A,
  projectId: 'proj1',
  workspaceId: 'ws1',
  purpose: 'staging' as const,
  region: 'sa-central',
  ...o,
});

describe('app environment guard', () => {
  const good = {
    PORT: '8080',
    STORE: 'pg',
    NODE_ENV: 'production',
    DATABASE_URL: vaultRefFor(ORG_A, 'p', 'db-url/x'),
    SESSION_SECRET: vaultRefFor(ORG_A, 'p', 'session-secret'),
  };
  it('accepts references only', () => {
    expect(checkAppEnvironment({ env: good, mode: 'references' })).toEqual({
      ok: true,
      reasons: [],
    });
  });
  it.each([
    [
      'a plain secret value',
      { ...good, SESSION_SECRET: 'a'.repeat(40) },
      'env_secret_not_a_vault_reference',
    ],
    [
      'a literal database url',
      { ...good, DATABASE_URL: 'postgres://u:pw@db:5432/x' },
      'env_secret_not_a_vault_reference',
    ],
    [
      'a vault reference of another shape',
      { ...good, DATABASE_URL: 'vault://platform/root' },
      'env_secret_not_a_vault_reference',
    ],
    ['a platform variable', { ...good, AWS_SECRET_ACCESS_KEY: 'x' }, 'env_name_not_allowed'],
    ['an inherited platform name', { ...good, NUZM_DB_ADMIN_URL: 'x' }, 'env_name_not_allowed'],
    [
      'a platform host',
      { ...good, NOTIFY_URL: 'https://platform-db.internal/x' },
      'env_points_at_platform_host',
    ],
    [
      'a platform secret value',
      { ...good, NOTIFY_URL: 'https://x.example/?k=PLATFORM-SECRET-VALUE-0123456789' },
      'env_contains_platform_secret',
    ],
    ['a missing database url', { PORT: '1', STORE: 'pg' }, 'env_database_url_missing'],
  ])('refuses %s', (_n, env, reason) => {
    const r = checkAppEnvironment({
      env,
      mode: 'references',
      platformHosts: ['platform-db.internal'],
      platformSecrets: ['PLATFORM-SECRET-VALUE-0123456789'],
    });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain(reason);
  });
});

describe('in-sandbox isolation evidence', () => {
  const ok = {
    inheritedEnvNames: [],
    databaseHost: '127.0.0.1',
    databaseRole: 'app_owner',
    roleSuperuser: false,
    roleBypassRls: false,
    migrationsApplied: 1,
    migrationsReapplied: 0,
    databaseDestroyed: true,
  };
  it('passes only with complete, clean evidence', () => {
    expect(verifySandboxIsolation(ok, { multiTenant: true }).ok).toBe(true);
    expect(verifySandboxIsolation(undefined, { multiTenant: false }).ok).toBe(false);
    for (const [k, v] of [
      ['inheritedEnvNames', ['DATABASE_URL']],
      ['databaseHost', 'db.example'],
      ['roleSuperuser', true],
      ['roleBypassRls', true],
      ['migrationsApplied', 0],
      ['migrationsReapplied', 1],
      ['databaseDestroyed', false],
    ] as const)
      expect(verifySandboxIsolation({ ...ok, [k]: v }, { multiTenant: false }).ok, k).toBe(false);
  });
  it('the probe run request names a profile, no command, no environment, loopback only, and destroys the workspace', () => {
    const r = planProbeRun('ws9');
    expect(r).toMatchObject({
      profile: 'app-probe',
      network: 'loopback-only',
      env: {},
      destroyWorkspaceOnExit: true,
    });
    expect(JSON.stringify(r)).not.toMatch(/argv|command|cmd|password|secret/i);
  });
});

describe('managed database provisioning (SIMULATED port)', () => {
  it('creates one database per workspace, keeps the password in the vault and returns references only', async () => {
    const { p, sim, events } = setup();
    const r = await p.provision(req());
    expect(r.state).toBe('ready');
    expect(sim.databases.size).toBe(1);
    expect(sim.secrets.has(r.passwordRef)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/postgres:\/\/|password"/);
    const env = await p.environmentFor(ORG_A, r.id, { projectId: 'proj1', port: 8080 });
    expect(Object.values(env).filter((v) => v.startsWith('vault://')).length).toBe(2);
    expect(events).toEqual(['app_database.created']);
  });
  it('is idempotent: the same workspace gets the same database, and two workspaces get two', async () => {
    const { p, sim } = setup();
    const a = await p.provision(req());
    const b = await p.provision(req());
    expect(b.id).toBe(a.id);
    expect(sim.calls.filter((c) => c === 'create')).toHaveLength(1);
    const c = await p.provision(req({ workspaceId: 'ws2' }));
    expect(c.names.database).not.toBe(a.names.database);
    expect(sim.databases.size).toBe(2);
  });
  it('names come from ids only and differ per organisation, workspace and purpose', () => {
    const n = deriveNames(ORG_A, 'ws1', 'staging');
    expect(n.database).toMatch(/^app_[0-9a-f]{20}$/);
    expect(deriveNames(ORG_B, 'ws1', 'staging')).not.toEqual(n);
    expect(deriveNames(ORG_A, 'ws2', 'staging')).not.toEqual(n);
    expect(deriveNames(ORG_A, 'ws1', 'preview')).not.toEqual(n);
  });
  it('refuses a region the residency policy does not allow, before anything is created', async () => {
    const { p, sim } = setup({ allow: false });
    await expect(p.provision(req())).rejects.toThrow(ProvisionRefused);
    expect(sim.calls).toEqual([]);
  });
  it('an AMBIGUOUS create (timeout after the instance created it) is reconciled, not duplicated', async () => {
    const { p, sim, ledger } = setup();
    sim.failNextCreate = 'ambiguous';
    await expect(p.provision(req())).rejects.toThrow('timeout');
    expect((await ledger.all())[0]!.state).toBe('creating');
    const r = await p.provision(req()); // the retry reconciles first
    expect(r.state).toBe('ready');
    expect(sim.databases.size).toBe(1);
    expect(sim.calls.filter((c) => c === 'create')).toHaveLength(1);
  });
  it('a CLEAN failure is reconciled to failed and the next call creates again', async () => {
    const { p, sim } = setup();
    sim.failNextCreate = 'clean';
    await expect(p.provision(req())).rejects.toThrow('provider unavailable');
    const failed = await p.provision(req());
    expect(failed.state).toBe('failed');
    const again = await p.provision(req());
    expect(again.state).toBe('ready');
    expect(sim.databases.size).toBe(1);
  });
  it('is tenant-scoped: another organisation cannot read, build an environment for or destroy the record', async () => {
    const { p, sim } = setup();
    const r = await p.provision(req());
    await expect(p.environmentFor(ORG_B, r.id, { projectId: 'proj1', port: 1 })).rejects.toThrow(
      /not_found/,
    );
    expect(await p.destroyForWorkspace(ORG_B, 'ws1')).toBe(0);
    expect(sim.databases.size).toBe(1);
    const other = await p.provision(req({ orgId: ORG_B }));
    expect(other.id).not.toBe(r.id);
    expect(other.names.database).not.toBe(r.names.database);
  });
  it('destroying the workspace destroys the database and its secret, once', async () => {
    const { p, sim, events } = setup();
    const r = await p.provision(req());
    expect(await p.destroyForWorkspace(ORG_A, 'ws1')).toBe(1);
    expect(sim.databases.size).toBe(0);
    expect(sim.secrets.size).toBe(0);
    expect(await p.destroyForWorkspace(ORG_A, 'ws1')).toBe(0);
    expect(events).toContain('app_database.destroyed');
    await expect(p.environmentFor(ORG_A, r.id, { projectId: 'proj1', port: 1 })).rejects.toThrow(
      /database_not_ready/,
    );
  });
  it('the sweeper destroys databases of workspaces that are gone and databases no record knows', async () => {
    const { p, sim } = setup();
    await p.provision(req());
    await p.provision(req({ workspaceId: 'ws2' }));
    sim.databases.set('app_stray', {
      names: { database: 'app_stray', role: 'app_stray_r' },
      tags: { 'nuzm-org': ORG_A },
      region: 'sa-central',
    });
    const r = await p.sweep(new Set(['ws2']));
    expect(r.destroyed).toBe(2); // ws1's database and the stray one
    expect([...sim.databases.keys()].length).toBe(1);
  });
  it('a database whose secret is missing is not usable and is removed on reconcile', async () => {
    const { p, sim, ledger } = setup();
    sim.failNextCreate = 'ambiguous';
    await expect(p.provision(req())).rejects.toThrow();
    sim.secrets.clear();
    const r = await p.provision(req());
    expect(r.state).toBe('failed');
    expect(sim.databases.size).toBe(0);
    expect((await ledger.all())[0]!.error).toBe('secret_missing');
  });
  it('is labelled SIMULATED', () => {
    expect(new SimulatedManagedDatabase().label).toBe('SIMULATED');
  });
});
