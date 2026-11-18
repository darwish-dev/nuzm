import type { SafeRequest, SafeResponse } from '@nuzm/domain';
import { Harness, cookieHeader } from '../../identity/testing/app-harness';
import { makeSession, type Session, type Row } from '../../data/testing/data-harness';
import {
  AiRunPort,
  DeploymentPort,
  EgressHttpPort,
  EmailSendPort,
  NuzmApiPort,
  TargetResidencyPort,
} from '../index';

export type { Row };

/** Records every call; the handler decides the answer. */
export class FakeEgress extends EgressHttpPort {
  calls: SafeRequest[] = [];
  handler: (r: SafeRequest, n: number) => SafeResponse | Promise<SafeResponse> = () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"ok":true}',
    finalUrl: '',
    redirects: 0,
  });
  async request(r: SafeRequest): Promise<SafeResponse> {
    this.calls.push(r);
    return this.handler(r, this.calls.length);
  }
}
/** Dedupes by idempotency key exactly like a receiver that honours `Idempotency-Key` (M08 messages are unique per (org, key)). */
export class FakeEmail extends EmailSendPort {
  effects = new Map<string, { messageId: string; body: Record<string, unknown> }>();
  attempts = 0;
  failWith?: () => Error | null;
  async send(i: Parameters<EmailSendPort['send']>[0]) {
    this.attempts++;
    const err = this.failWith?.();
    if (err) throw err;
    if (!this.effects.has(i.idempotencyKey))
      this.effects.set(i.idempotencyKey, {
        messageId: `msg-${this.effects.size + 1}`,
        body: i.body,
      });
    return { messageId: this.effects.get(i.idempotencyKey)!.messageId, state: 'queued' };
  }
}
export class FakeNuzmApi extends NuzmApiPort {
  calls: { method: string; path: string; token: string; key: string }[] = [];
  async call(i: Parameters<NuzmApiPort['call']>[0]) {
    this.calls.push({ method: i.method, path: i.path, token: i.token, key: i.idempotencyKey });
    return { status: 200, body: { ok: true } };
  }
}
export class FakeAi extends AiRunPort {
  runs = new Map<string, string>();
  async start(i: Parameters<AiRunPort['start']>[0]) {
    if (!this.runs.has(i.idempotencyKey))
      this.runs.set(i.idempotencyKey, `run-${this.runs.size + 1}`);
    return { runId: this.runs.get(i.idempotencyKey)!, status: 'queued' };
  }
}
export class FakeDeploy extends DeploymentPort {
  deployments = new Map<string, string>();
  async create(i: Parameters<DeploymentPort['create']>[0]) {
    if (!this.deployments.has(i.idempotencyKey))
      this.deployments.set(i.idempotencyKey, `dep-${this.deployments.size + 1}`);
    return { deploymentId: this.deployments.get(i.idempotencyKey)!, status: 'queued' };
  }
}
export class AllowResidency extends TargetResidencyPort {
  deny = false;
  async check() {
    return this.deny ? { allowed: false, reason: 'denied by test' } : { allowed: true };
  }
}

export interface Fakes {
  egress: FakeEgress;
  email: FakeEmail;
  nuzm: FakeNuzmApi;
  ai: FakeAi;
  deploy: FakeDeploy;
  residency: AllowResidency;
}
export interface AutoEnv extends Session {
  fakes: Fakes;
  padmin: string;
  secrets: { put(id: string, v: string): Promise<string>; get(ref: string): Promise<string> };
  sink: { events: { action: string; [k: string]: any }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  setFlag(key: string, value: unknown, orgId?: string | null): Promise<void>;
}

/** Full application on a throwaway database: orgs A (alice owner, carol viewer, dave developer, erin admin) and B (bob owner), automation flags ON, fake ports. */
export async function setupAutomationEnv(
  extra: [unknown, unknown][] = [],
  flagsOn = true,
  realAudit = false,
): Promise<AutoEnv> {
  process.env.AUTOMATION_KICK = 'off';
  process.env.AUTOMATION_RETRY_BASE_SECONDS = '0';
  process.env.AUTOMATION_MAX_CONCURRENT = '3';
  process.env.DSR_KICK = 'off';
  process.env.DATA_KICK = 'off';
  const fakes: Fakes = {
    egress: new FakeEgress(),
    email: new FakeEmail(),
    nuzm: new FakeNuzmApi(),
    ai: new FakeAi(),
    deploy: new FakeDeploy(),
    residency: new AllowResidency(),
  };
  const h = new Harness();
  await h.init();
  const { app, sink, secrets } = await h.buildApp({}, undefined, [], {
    realAudit,
    overrides: [
      [EgressHttpPort, fakes.egress],
      [EmailSendPort, fakes.email],
      [NuzmApiPort, fakes.nuzm],
      [AiRunPort, fakes.ai],
      [DeploymentPort, fakes.deploy],
      [TargetResidencyPort, fakes.residency],
      ...extra,
    ],
  });
  const s = makeSession(h, app);
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) {
    s.ids[n] = await h.createUser(n);
    s.jars[n] = await h.sessionFor(app, s.ids[n]!);
  }
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin']) await h.elevate(s.jars[n]!);
  const mk = async (who: string, name: string, type = 'customer') =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(s.jars[who]!), 'x-csrf-token': s.jars[who]!.nuzm_csrf! },
        payload: { name, type },
      })
    ).json().id as string;
  s.org.A = await mk('alice', 'Auto A');
  s.org.B = await mk('bob', 'Auto B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'developer'],
    ['erin', 'admin'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [s.org.A, s.ids[u], role],
    );
  const p1 = await h.platformUser(app, 'padmin', ['platform_admin']);
  s.jars.padmin = p1.jar;
  const setFlag = async (key: string, value: unknown, orgId: string | null = null) => {
    await h.env.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (key, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'::uuid)) DO UPDATE SET value = EXCLUDED.value`,
      [key, orgId, JSON.stringify(value)],
    );
  };
  if (flagsOn) for (const k of ['automation.enabled', 'webhooks.enabled']) await setFlag(k, true);
  return { ...s, fakes, padmin: p1.id, secrets, sink: sink as AutoEnv['sink'], setFlag };
}
