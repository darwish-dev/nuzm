import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, ORG_A, ORG_B, SEED_USER, type TestEnv } from '@nuzm/platform/testing';
import { RecordingSink } from './internal/testing/engine-harness';
import { MemoryProjects, StaticOrgBudget } from './internal/ports/m09-mock';
import { CanaryRegistry, MemorySecurityAlerts } from './internal/sandbox/canary';
import { DEFAULT_ALLOW, EgressPolicy } from './internal/sandbox/egress';
import { ATTEMPTS, MIN_ATTEMPTS, runEscapeSuite, type TicketApi } from './internal/sandbox/escape-suite';
import { checkPath, scanSecrets } from './internal/sandbox/paths';
import { MockSandboxRuntime } from './internal/sandbox/mock-runtime';
import { SandboxService, TICKET_TTL_SECONDS, DEFAULT_SANDBOX_CONFIG } from './internal/sandbox/sandbox.service';
import { LocalDevSandboxRuntime } from './internal/sandbox/local-dev-runtime';

let env: TestEnv;
let runtime: MockSandboxRuntime;
let alerts: MemorySecurityAlerts;
let canaries: CanaryRegistry;
let svc: SandboxService;
let projects: MemoryProjects;
let budget: StaticOrgBudget;
let denyResidency = false;
let clock = new Date('2026-11-18T10:00:00Z');
const sink = new RecordingSink();
const residency = { evaluate: async () => (denyResidency ? { decision: 'deny' as const, reasons: [{ code: 'x', message: { en: 'region not allowed', ar: 'x' } }] } : { decision: 'allow' as const, reasons: [] }) } as never;

const proj = async (org = ORG_A) => projects.create(org, { type: 'webapp', name: 'p', dataRegion: 'sa-central', createdBy: SEED_USER });
const mk = async (org = ORG_A) => svc.create(org, SEED_USER, await proj(org), {});

beforeAll(async () => {
  env = await createEnv();
  runtime = new MockSandboxRuntime(100);
  alerts = new MemorySecurityAlerts();
  canaries = new CanaryRegistry(alerts);
  projects = new MemoryProjects();
  budget = new StaticOrgBudget();
  svc = new SandboxService(env.app, sink, runtime, residency, budget, canaries, DEFAULT_SANDBOX_CONFIG, () => clock);
}, 120_000);
afterAll(() => env.close());

describe('sandbox lifecycle (S45)', () => {
  it('creates a ready sandbox labelled with what really runs it (mock: simulated, never verified)', async () => {
    const s = await mk();
    expect(s).toMatchObject({ state: 'ready', runtime: { kind: 'mock', isolation: 'simulated' }, dataRegion: 'sa-central' });
    expect(SandboxService.isolationEvidence(s)).toBe(false);
    expect(s.quota).toMatchObject({ vcpu: 2, memoryMb: 4096, diskGb: 10, pids: 512 });
    expect(sink.events.some((e) => e.action === 'sandbox.sandbox.created')).toBe(true);
    await expect(env.sql(`UPDATE builder.sandboxes SET isolation = 'verified' WHERE id = $1`, [s.id])).rejects.toThrow();
  });
  it('20 parallel creates at the quota edge admit exactly 5 and refuse 15 with sandbox_quota_exceeded', async () => {
    const org = ORG_B;
    const results = await Promise.allSettled(Array.from({ length: 20 }, async () => svc.create(org, SEED_USER, await proj(org), {})));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const no = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(no).toHaveLength(15);
    expect(no.every((r) => r.reason.code === 'sandbox_quota_exceeded')).toBe(true);
    expect((await env.sql(`SELECT count(*)::int n FROM builder.sandboxes WHERE org_id = $1 AND state = 'ready'`, [org]))[0]!.n).toBe(5);
  });
  it('no node capacity is a 503; a residency denial is a 403 before anything is placed; no credit is a 402', async () => {
    const p = await proj();
    runtime.setSlots(0);
    await expect(svc.create(ORG_A, SEED_USER, p, {})).rejects.toMatchObject({ code: 'sandbox_no_capacity' });
    runtime.setSlots(100);
    denyResidency = true;
    const before = (await env.sql(`SELECT count(*)::int n FROM builder.sandboxes`))[0]!.n;
    await expect(svc.create(ORG_A, SEED_USER, p, {})).rejects.toMatchObject({ code: 'residency_denied' });
    expect((await env.sql(`SELECT count(*)::int n FROM builder.sandboxes`))[0]!.n).toBe(before);
    denyResidency = false;
    budget.remaining = 0;
    await expect(svc.create(ORG_A, SEED_USER, p, {})).rejects.toMatchObject({ code: 'budget_required' });
    budget.remaining = 1_000_000_00;
    await expect(svc.create(ORG_A, SEED_USER, { ...p, type: 'mobile' }, {})).rejects.toMatchObject({ code: 'unsupported_capability' });
    await expect(svc.create(ORG_A, SEED_USER, p, { ttlMinutes: 9999 })).rejects.toMatchObject({ code: 'validation_failed' });
  });
  it('idle (30 min) and maximum lifetime (4 h) sandboxes are reaped, the runtime destroys them, the record stays', async () => {
    const a = await mk();
    const b = await mk();
    const handleCount = runtime.sandboxes.size;
    clock = new Date(clock.getTime() + 31 * 60_000);
    await svc.exec(ORG_A, SEED_USER, null, b.id, ['echo', 'keep alive']); // activity keeps b alive
    const n = await svc.reapExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await svc.get(ORG_A, a.projectId, a.id)).state).toBe('terminated');
    expect((await svc.get(ORG_A, a.projectId, a.id)).terminationReason).toBe('idle');
    expect((await svc.get(ORG_A, b.projectId, b.id)).state).toBe('ready');
    expect(runtime.sandboxes.size).toBeLessThan(handleCount);
    clock = new Date(clock.getTime() + 5 * 3_600_000);
    await svc.reapExpired();
    const gone = await svc.get(ORG_A, b.projectId, b.id);
    expect(gone.state).toBe('terminated');
    expect(['max_lifetime', 'ttl']).toContain(gone.terminationReason);
    expect((await svc.terminate(ORG_A, SEED_USER, null, b.id)).state).toBe('terminated'); // idempotent
  });
  it('command output is scanned for canaries (alert) and redacted of secret patterns before it is returned', async () => {
    const s = await mk();
    const planted = canaries.plantStandardSet();
    runtime.register('leak', () => ({ stdout: `token ${planted[0]!.value} and AKIAABCDEFGHIJKLMNOP\n`, exitCode: 0 }));
    const r = await svc.exec(ORG_A, SEED_USER, null, s.id, ['leak']);
    expect(r.canaryHits).toBe(1);
    expect(r.stdout).not.toContain(planted[0]!.value);
    expect(r.stdout).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(alerts.alerts.some((a) => a.kind === 'canary_triggered' && a.sandboxId === s.id)).toBe(true);
  });
  it('an argv that is not a string list, or a path traversal write, is refused; a missing command is exit 127', async () => {
    const s = await mk();
    await expect(svc.exec(ORG_A, SEED_USER, null, s.id, [] as never)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(svc.writeFiles(ORG_A, null, s.id, new Map([['../../etc/passwd', 'x']]))).rejects.toMatchObject({ code: 'change_rejected' });
    expect((await svc.exec(ORG_A, SEED_USER, null, s.id, ['nope'])).exitCode).toBe(127);
  });
  it('ai.sandbox_cpu_seconds: one event per window (idempotent), and the metered sum equals the runtime total (variance 0 %)', async () => {
    const s = await mk();
    runtime.register('burn', () => ({ cpuSeconds: 12.5, exitCode: 0 }));
    await svc.exec(ORG_A, SEED_USER, null, s.id, ['burn']);
    const m1 = await svc.meterCpu(ORG_A, s.id);
    expect(m1!.quantity).toBe('12.500');
    expect(await svc.meterCpu(ORG_A, s.id)).toBeNull(); // same window: nothing new
    clock = new Date(clock.getTime() + 61_000);
    await svc.exec(ORG_A, SEED_USER, null, s.id, ['burn']);
    await svc.terminate(ORG_A, SEED_USER, null, s.id); // final emit on terminate
    const ev = await env.sql(`SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND payload->>'resourceId' = $1 ORDER BY id`, [s.id]);
    const total = ev.reduce((n, r) => n + Number((r.payload as { quantity: string }).quantity), 0);
    expect(new Set(ev.map((r) => (r.payload as { eventId: string }).eventId)).size).toBe(ev.length);
    expect(total).toBeCloseTo(25, 3);
    expect(ev.every((r) => (r.payload as { meterId: string }).meterId === 'ai.sandbox_cpu_seconds')).toBe(true);
  });
  it('cross-tenant: org B sees 404 for a sandbox of org A on every operation', async () => {
    const s = await mk(ORG_A);
    for (const f of [() => svc.get(ORG_B, s.projectId, s.id), () => svc.get(ORG_B, null as never, s.id), () => svc.terminate(ORG_B, SEED_USER, null, s.id), () => svc.exec(ORG_B, SEED_USER, null, s.id, ['echo']), () => svc.issueTicket(ORG_B, SEED_USER, null, s.id), () => svc.writeFiles(ORG_B, null, s.id, new Map())])
      await expect(f()).rejects.toMatchObject({ code: 'not_found' });
    expect(await svc.list(ORG_B, s.projectId)).toEqual([]);
  });
  it('another project of the same organization cannot reach the sandbox either (project binding)', async () => {
    const s = await mk(ORG_A);
    const other = await proj(ORG_A);
    await expect(svc.get(ORG_A, other.id, s.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('terminal tickets', () => {
  it('single use, 60 s, bound to the user and the sandbox, never stored in clear', async () => {
    const s = await mk(ORG_A);
    const t = await svc.issueTicket(ORG_A, SEED_USER, null, s.id);
    expect((await env.sql(`SELECT ws_ticket_hash FROM builder.sandboxes WHERE id = $1`, [s.id]))[0]!.ws_ticket_hash).not.toContain(t.ticket);
    await svc.redeemTicket(ORG_A, SEED_USER, s.id, t.ticket);
    await expect(svc.redeemTicket(ORG_A, SEED_USER, s.id, t.ticket)).rejects.toMatchObject({ code: 'ticket_invalid' });
    const t2 = await svc.issueTicket(ORG_A, SEED_USER, null, s.id);
    await expect(svc.redeemTicket(ORG_A, '00000000-0000-7000-8000-0000000000aa', s.id, t2.ticket)).rejects.toMatchObject({ code: 'ticket_invalid' });
    clock = new Date(clock.getTime() + (TICKET_TTL_SECONDS + 1) * 1000);
    await expect(svc.redeemTicket(ORG_A, SEED_USER, s.id, t2.ticket)).rejects.toMatchObject({ code: 'ticket_invalid' });
  });
});

describe('path and secret checks (changes API building blocks)', () => {
  it('accepts normal project paths', () => {
    for (const p of ['src/app.ts', 'public/index.html', 'db/migrations/0001_init.sql', 'tests/a.test.ts', 'README.md', 'docs/RBAC.md']) expect(checkPath(p), p).toBeNull();
  });
  it('rejects every traversal / absolute / encoded / reserved form', () => {
    for (const p of ['', '../x', 'a/../x', '/abs', 'C:/x', '~/x', 'a//b', 'a/./b', '..', '.git/x', 'a/.git/b', 'x\\y', 'a\0b', 'a%2e%2e/b', 'a/b/', '.env/', 'src/\u202etxt', '.ssh/id_rsa', 'node_modules/x', 'a'.repeat(300)]) expect(checkPath(p), JSON.stringify(p)).not.toBeNull();
  });
  it('finds secrets by rule and line, never returning the secret, and ignores placeholders', () => {
    const f = scanSecrets('ok\nconst k = "AKIAABCDEFGHIJKLMNOP";\npostgres://u:hunter2secret@db/x\nSESSION_SECRET=change-me-please\nprocess.env.DATABASE_URL');
    expect(f).toEqual([{ rule: 'aws_access_key_id', line: 2 }, { rule: 'database_url_with_password', line: 3 }]);
    expect(JSON.stringify(f)).not.toContain('hunter2');
  });
});

describe('escape-attempt suite (AC-M10-02) against the MOCK runtime: control-plane controls only', () => {
  it(`runs ≥ ${MIN_ATTEMPTS} attempts; 0 escapes; the isolating-runtime attempts are NOT VERIFIED, and isolation evidence is false`, async () => {
    for (const r of await env.sql(`SELECT id FROM builder.sandboxes WHERE org_id = $1 AND state = 'ready'`, [ORG_A])) await svc.terminate(ORG_A, SEED_USER, null, r.id as string);
    const s = await mk(ORG_A);
    const other = await mk(ORG_A);
    const egress = new EgressPolicy(DEFAULT_ALLOW, async (h) => ({ 'npm-mirror.nuzm.internal': ['93.184.216.10'], 'git.nuzm.internal': ['93.184.216.11'] })[h] ?? (() => { throw new Error('NXDOMAIN'); })());
    const handle = (await env.sql(`SELECT runtime_handle FROM builder.sandboxes WHERE id = $1`, [s.id]))[0]!.runtime_handle as string;
    const tickets: TicketApi = {
      issue: async () => (await svc.issueTicket(ORG_A, SEED_USER, null, s.id)).ticket,
      redeem: async (t, who) => {
        try {
          if (who === 'other_org') await svc.redeemTicket(ORG_B, SEED_USER, s.id, t);
          else if (who === 'other_sandbox') await svc.redeemTicket(ORG_A, SEED_USER, other.id, t);
          else await svc.redeemTicket(ORG_A, who === 'other_user' ? '00000000-0000-7000-8000-0000000000bb' : SEED_USER, s.id, t);
          return true;
        } catch {
          return false;
        }
      },
      expire: async () => {
        clock = new Date(clock.getTime() + (TICKET_TTL_SECONDS + 1) * 1000);
      },
    };
    const ctx = {
      egress, runtime, canaries, handle, tickets,
      // the same checks the changes API applies: path + secret patterns + canary tokens
      writeThroughChanges: async (p: string, c: string) => checkPath(p) === null && scanSecrets(c).length === 0,
    };
    const report = await runEscapeSuite(ctx);
    expect(ATTEMPTS.length).toBeGreaterThanOrEqual(MIN_ATTEMPTS);
    expect(report.total).toBe(ATTEMPTS.length);
    expect(report.escaped).toBe(0);
    expect(report.results.filter((r) => r.status === 'ESCAPED')).toEqual([]);
    expect(report.blocked).toBeGreaterThanOrEqual(MIN_ATTEMPTS - 10);
    expect(report.notVerified).toBeGreaterThan(40);
    expect(report.results.filter((r) => r.requires === 'isolating-runtime').every((r) => r.status === 'NOT_VERIFIED')).toBe(true);
    expect(report.results.filter((r) => r.requires === 'control-plane').every((r) => r.status === 'BLOCKED')).toBe(true);
    expect(report.isolationEvidence).toBe(false);
    expect(new Set(report.results.map((r) => r.category)).size).toBeGreaterThanOrEqual(12);
    expect(new Set(ATTEMPTS.map((a) => a.id)).size).toBe(ATTEMPTS.length);
  });
});

describe('local dev runner (NOT isolated; dev only)', () => {
  it('refuses to start unless explicitly enabled, never in production', () => {
    delete process.env.SANDBOX_LOCAL_DEV;
    expect(() => new LocalDevSandboxRuntime()).toThrow(/disabled/);
    process.env.SANDBOX_LOCAL_DEV = 'true';
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(() => new LocalDevSandboxRuntime()).toThrow(/disabled/);
    process.env.NODE_ENV = prev;
  });
  it('runs allow-listed commands without a shell, with a scrubbed environment and a wall-clock kill; labelled isolation none', async () => {
    process.env.SANDBOX_LOCAL_DEV = 'true';
    process.env.NUZM_SECRET_PROBE = 'should-not-leak';
    const rt = new LocalDevSandboxRuntime();
    expect(rt).toMatchObject({ kind: 'local-dev', isolation: 'none' });
    const h = await rt.create({ sandboxId: 'x', orgId: ORG_A, projectId: 'p', quota: { vcpu: 1, memoryMb: 1, diskGb: 1, pids: 1, buildTimeoutMinutes: 1 }, egressProfile: 'default' });
    await rt.writeFiles(h, new Map([['a.js', 'console.log(JSON.stringify({probe: process.env.NUZM_SECRET_PROBE ?? null, db: process.env.DATABASE_URL ?? null}))']]));
    const r = await rt.exec(h, { argv: ['node', 'a.js'], timeoutMs: 10_000 });
    expect(JSON.parse(r.stdout)).toEqual({ probe: null, db: null });
    expect((await rt.exec(h, { argv: ['sh', '-c', 'id'], timeoutMs: 5_000 })).exitCode).toBe(126);
    expect((await rt.exec(h, { argv: ['curl', 'http://x'], timeoutMs: 5_000 })).exitCode).toBe(126);
    await rt.writeFiles(h, new Map([['spin.js', 'while(true){}']]));
    const t = await rt.exec(h, { argv: ['node', 'spin.js'], timeoutMs: 500 });
    expect(t.timedOut).toBe(true);
    await expect(rt.writeFiles(h, new Map([['../escape.txt', 'x']]))).rejects.toThrow();
    await rt.destroy(h);
    delete process.env.NUZM_SECRET_PROBE;
  });
});
