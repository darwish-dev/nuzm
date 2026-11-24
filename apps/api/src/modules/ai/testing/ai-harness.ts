import { v7 as uuidv7 } from 'uuid';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { Harness, cookieHeader, type App } from '../../identity/testing/app-harness';
import { LedgerPostingService, recipes } from '../../billing';
import { ModelAdapterRegistry, StaticModelAdapterRegistry } from '../index';

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests

export const CANARY_A = 'CANARY-PLATFORM-SECRET-0001';
export const CANARY_B = 'CANARY-VAULT-TOKEN-0002';

/** Environment of the AI integration tests: dev-reference mock model on, no background kicks, platform secret canaries planted. */
export function applyAiTestEnv() {
  process.env.AI_LOCAL_REFERENCE = 'true';
  process.env.AI_KICK = 'off';
  process.env.AI_SECRET_CANARIES = `${CANARY_A},${CANARY_B}`;
  process.env.AI_CREDIT_UNIT_MINOR = '1';
  // resilience (S-AG4): the shared gateway of these suites must stay deterministic: no backoff sleep, and a breaker that no scripted failure streak can trip (resilience.int.spec.ts builds its own gateway)
  process.env.AI_RETRY_BASE_MS = '0';
  process.env.AI_BREAKER_THRESHOLD = '100000';
  process.env.AI_SSE_POLL_MS = '20';
  process.env.BUILDER_KICK = 'off';
  process.env.DEPLOY_KICK = 'off';
  process.env.FORM_RATE_LIMIT_PER_MINUTE = '5';
  process.env.BUILDER_TRUST_FORWARDED = 'true';
}

export interface AiEnv {
  h: Harness;
  app: App;
  jars: Record<string, Record<string, string>>;
  ids: Record<string, string>;
  org: Record<string, string>;
  sink: { events: { action: string; [k: string]: any }[] }; // eslint-disable-line @typescript-eslint/no-explicit-any
  registry: StaticModelAdapterRegistry;
  call(
    who: string,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
    org?: string,
    extra?: Record<string, string>,
  ): ReturnType<App['inject']>;
  admin(
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: object | Buffer,
    headers?: Record<string, string>,
  ): ReturnType<App['inject']>;
  /** configure → attest (LOCAL-REFERENCE-NOT-VERIFIED) → request → enable a dev-reference provider through the admin API; returns the provider row */
  enableMock(
    code?: string,
    o?: { region?: string; rate?: [string, string]; adapter?: MockModelAdapter; attest?: boolean },
  ): Promise<{ row: Row; adapter: MockModelAdapter }>;
  fund(orgId: string, minor: string): Promise<void>;
  wallet(orgId: string): Promise<bigint>;
  sql: Harness['env']['sql'];
}

const ADMIN_ROPA_PROCESSORS = (codes: string[]) =>
  JSON.stringify(
    codes.map((name) => ({
      name,
      dataClasses: ['customer-content', 'personal'],
      region: 'any',
      purpose: 'AI model calls (test fixture)',
    })),
  );

export async function setupAiEnv(opts: { overrides?: [unknown, unknown][] } = {}): Promise<AiEnv> {
  applyAiTestEnv();
  const h = new Harness();
  await h.init();
  const { app, sink } = await h.buildApp({}, undefined, [], {
    ...(opts.overrides ? { overrides: opts.overrides } : {}),
  });
  const jars: AiEnv['jars'] = {};
  const ids: AiEnv['ids'] = {};
  const org: AiEnv['org'] = {};
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) await h.elevate(jars[n]!);
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  org.A = await mk('alice', 'AI A');
  org.B = await mk('bob', 'AI B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'developer'],
    ['erin', 'admin'],
    ['frank', 'billing_admin'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [org.A, ids[u], role],
    );
  const p1 = await h.platformUser(app, 'padmin', ['platform_admin']);
  const p2 = await h.platformUser(app, 'padmin2', ['platform_admin']);
  jars.padmin = p1.jar;
  jars.padmin2 = p2.jar;
  ids.padmin = p1.id;
  ids.padmin2 = p2.id;
  await h.env.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.enabled', NULL, 'true')`,
  );
  // processors of the model adapter kind must be in the ROPA (M04 residency evaluator): a new version of the placeholder entry
  await h.env.sql(
    `INSERT INTO compliance.ropa_entries (id, entry_key, version, org_id, kind, adapter_kind, activity, purpose, data_classes, processors, regions, status, change_note)
     VALUES (gen_random_uuid(), 'adapter:model', 2, NULL, 'adapter', 'model', 'Model providers', 'AI generation (test fixture)', '{customer-content,personal}', $1::jsonb, '{}', 'draft', 'test fixture')`,
    [
      ADMIN_ROPA_PROCESSORS([
        'mock-model',
        'mock-model-eu',
        'mock-model-b',
        'mock-model-c',
        'acme-llm',
        // S-AG4 resilience and insights suites
        'mock-res-a',
        'mock-res-b',
        'mock-retry',
        'mock-fb-a',
        'mock-fb-b',
        'mock-health',
        'mock-reg',
        'mock-use-a',
        'mock-use-b',
        'mock-use-c',
        'mock-disc',
        'mock-nodisc',
        'acme-reg',
        // Phase 2 spending-cap suite
        'mock-cap-ok',
        'mock-cap-vendor',
      ]),
    ],
  );
  const registry = app.get(ModelAdapterRegistry) as StaticModelAdapterRegistry;
  const e: AiEnv = {
    h,
    app,
    jars,
    ids,
    org,
    sink: sink as AiEnv['sink'],
    registry,
    sql: h.env.sql.bind(h.env),
    call: (who, method, url, body, o, extra = {}) =>
      app.inject({
        method,
        url,
        headers: {
          cookie: cookieHeader(jars[who]!),
          'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
          'x-nuzm-org': o ?? org.A!,
          'idempotency-key': `k-${Math.random()}`,
          ...extra,
        },
        ...(body ? { payload: body } : {}),
      }),
    admin: (who, method, url, body, headers = {}) =>
      app.inject({
        method,
        url,
        headers: {
          cookie: cookieHeader(jars[who]!),
          'x-csrf-token': jars[who]!.nuzm_admin_csrf ?? '',
          'idempotency-key': `k-${Math.random()}`,
          ...(Buffer.isBuffer(body) ? { 'content-type': 'application/octet-stream' } : {}),
          ...headers,
        },
        ...(body ? { payload: body } : {}),
      }),
    async enableMock(code = 'mock-model', o = {}) {
      const adapter =
        o.adapter ?? new MockModelAdapter({ id: code, region: o.region ?? 'sa-central' });
      registry.register(code, adapter);
      const [rin, rout] = o.rate ?? ['1000000', '2000000'];
      const models = Object.fromEntries(
        adapter
          .models()
          .map((m) => [m.modelId, { creditsPerMillionInput: rin, creditsPerMillionOutput: rout }]),
      );
      const c = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
        action: 'configure',
        code,
        adapter: 'mock',
        displayName: `Mock ${code}`,
        region: o.region ?? 'sa-central',
        vaultRef: 'vault://mock/ai',
        rateCard: { models },
        rateCardVersion: 'test-1',
      });
      if (c.statusCode !== 200) throw new Error(`configure ${code}: ${c.statusCode} ${c.body}`);
      const id = c.json().id as string;
      const steps: object[] = [];
      if (o.attest !== false)
        steps.push({
          action: 'attest',
          id,
          attestationRef: 'LOCAL-REFERENCE-NOT-VERIFIED',
          dataTerms: { retainsPrompts: false, trainsOnData: false },
        });
      steps.push({ action: 'request_enable', id }, { action: 'enable', id });
      for (const b of steps) {
        const r = await e.admin(
          b === steps[steps.length - 1] ? 'padmin2' : 'padmin',
          'POST',
          '/v1/admin/ai/model-providers',
          b,
        );
        if (r.statusCode !== 200)
          throw new Error(`${JSON.stringify(b)}: ${r.statusCode} ${r.body}`);
      }
      const row = (
        await e.h.env.sql(`SELECT * FROM ai.model_providers WHERE id = $1`, [id])
      )[0] as Row;
      return { row, adapter };
    },
    async fund(orgId, minor) {
      await app.get(LedgerPostingService).post(
        recipes.creditGrant({
          orgId,
          amountMinor: minor,
          currency: 'SAR',
          reason: 'ai test grant',
          grantId: uuidv7(),
        }),
        `grant-${uuidv7()}`,
      );
    },
    async wallet(orgId) {
      const r = await h.env.sql(
        `SELECT coalesce(sum(CASE WHEN p.direction = 'credit' THEN p.amount_minor ELSE -p.amount_minor END), 0) b
           FROM billing.ledger_accounts a JOIN billing.ledger_postings p ON p.account_id = a.id WHERE a.code = '2100' AND a.org_id = $1 AND a.currency = 'SAR'`,
        [orgId],
      );
      return BigInt(String(r[0]?.b ?? 0));
    },
  };
  return e;
}
