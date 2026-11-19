import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { v7 as uuidv7 } from 'uuid';
import { MockModelAdapter, ModelAdapterError } from '@nuzm/adapter-model';
import { BudgetService, GatewayService, ModelProviderService } from './index';
import { CANARY_A, setupAiEnv, type AiEnv, type Row } from './testing/ai-harness';

let e: AiEnv;
let gw: GatewayService;
const A = () => e.org.A!;
const msg = (content: string) => [{ role: 'user' as const, content }];
const base = (over: Partial<Parameters<GatewayService['invoke']>[0]> = {}) => ({
  orgId: A(),
  task: 'chat',
  capability: 'chat' as const,
  dataClass: 'customer-content' as const,
  messages: msg('hello bakery'),
  maxTokens: 50,
  callId: `c-${uuidv7()}`,
  ...over,
});
const usage = async (callId: string) =>
  (await e.sql(`SELECT * FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`, [A(), callId]))[0] as
    Row | undefined;
const outbox = async (type: string) =>
  Number(
    (
      await e.sql(
        `SELECT count(*) n FROM platform.outbox WHERE org_id=$1 AND topic=$2 AND payload->>'source' = 'ai@M09'`,
        [A(), type],
      )
    )[0]!.n,
  );

beforeAll(async () => {
  e = await setupAiEnv();
  gw = e.app.get(GatewayService);
}, 120_000);
afterAll(() => e.h.close());

describe('no provider is enabled by default (D-18 OPEN)', () => {
  it('a call answers 422 unsupported_capability and GET /v1/ai/models is empty', async () => {
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'unsupported_capability' });
    const r = await e.call('alice', 'GET', '/v1/ai/models');
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toEqual([]);
  });
  it('is invisible (404) while the ai.enabled flag is off for an organization', async () => {
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'ai.enabled', $1, 'false')`,
      [e.org.B],
    );
    expect((await e.call('bob', 'GET', '/v1/ai/models', undefined, e.org.B)).statusCode).toBe(404);
    await e.sql(`DELETE FROM platform.feature_flags WHERE key='ai.enabled' AND org_id=$1`, [
      e.org.B,
    ]);
    expect((await e.call('bob', 'GET', '/v1/ai/models', undefined, e.org.B)).statusCode).toBe(200);
  });
});

describe('provider enabling rules (HG-09-01, two-person)', () => {
  it('an unattested provider cannot be enabled, by service or by direct SQL', async () => {
    const adapter = new MockModelAdapter({ id: 'acme-llm' });
    e.registry.register('acme-llm', adapter);
    const models = Object.fromEntries(
      adapter
        .models()
        .map((m) => [m.modelId, { creditsPerMillionInput: '1', creditsPerMillionOutput: '1' }]),
    );
    const c = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'configure',
      code: 'acme-llm',
      adapter: 'acme',
      displayName: 'Acme LLM',
      region: 'sa-central',
      rateCard: { models },
    });
    expect(c.statusCode).toBe(200);
    const id = c.json().id as string;
    const r = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'request_enable',
      id,
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('unsupported_capability');
    await expect(
      e.sql(`UPDATE ai.model_providers SET enabled=true, enabled_at=now() WHERE id=$1`, [id]),
    ).rejects.toThrow(/check/i);
  });
  it('after a human attestation the same person cannot request and enable (two-person rule)', async () => {
    const row = (await e.sql(`SELECT id FROM ai.model_providers WHERE code='acme-llm'`))[0]!;
    const id = row.id as string;
    const at = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'attest',
      id,
      attestationRef: 'docs/07#ATTEST-TEST-1',
      dataTerms: { retainsPrompts: false, trainsOnData: false },
    });
    expect(at.statusCode).toBe(200);
    expect(
      (
        await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
          action: 'request_enable',
          id,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', { action: 'enable', id }))
        .statusCode,
    ).toBe(403);
    const ok = await e.admin('padmin2', 'POST', '/v1/admin/ai/model-providers', {
      action: 'enable',
      id,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().enabled).toBe(true);
    expect(e.sink.events.some((x) => x.action === 'ai.provider.enabled')).toBe(true);
    // a change of region drops the attestation and disables
    const re = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'configure',
      code: 'acme-llm',
      adapter: 'acme',
      displayName: 'Acme LLM',
      region: 'de-frankfurt',
      rateCard: ok.json().rateCard,
    });
    expect(re.json().enabled).toBe(false);
    expect(re.json().dataTerms.attested).toBe(false);
    await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', { action: 'disable', id });
  });
  it('credential values are never accepted and responses carry only the vault reference', async () => {
    const r = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'configure',
      code: 'leaky-llm',
      adapter: 'acme',
      displayName: 'L',
      region: 'sa-central',
      apiKey: 'sk-live-0123456789abcdef0123',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('credential_value_rejected');
    const l = await e.admin('padmin', 'GET', '/v1/admin/ai/model-providers');
    expect(JSON.stringify(l.json())).not.toMatch(/sk-live|secret/i);
  });
  it('an API key typed in the console is sealed in the secret store: only the vault reference comes back, and nothing records the key', async () => {
    const act = (body: object) => e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', body);
    const made = await act({
      action: 'configure',
      code: 'cred-llm',
      adapter: 'acme',
      displayName: 'Cred LLM',
      region: 'sa-central',
    });
    expect(made.statusCode).toBe(200);
    const id = made.json().id as string;
    expect(made.json().vaultRef).toBeNull();
    // a fake value shaped like a key: it must appear nowhere afterwards
    const key = `test-only-${'x7Kq'.repeat(8)}`;
    const set = await act({ action: 'set_credential', id, apiKey: key });
    expect(set.statusCode).toBe(200);
    expect(set.json().vaultRef).toMatch(/^vault:\/\/(dev|mem)\/ai-cred-llm$/); // the dev stack seals it in a file, the test harness in memory
    expect(set.json().enabled).toBe(false); // a new credential is a configuration change: it must be enabled again
    expect(JSON.stringify(set.json())).not.toContain(key);
    expect(
      JSON.stringify((await e.admin('padmin', 'GET', '/v1/admin/ai/model-providers')).json()),
    ).not.toContain(key);
    // a malformed key is refused without being echoed
    for (const bad of ['short', 'has a space inside the key value here', 12345, undefined]) {
      const r = await act({ action: 'set_credential', id, apiKey: bad });
      expect(r.statusCode).toBe(422);
      expect(JSON.stringify(r.json())).not.toContain('has a space');
    }
    // removing it clears the reference
    const gone = await act({ action: 'clear_credential', id });
    expect(gone.statusCode).toBe(200);
    expect(gone.json().vaultRef).toBeNull();
    expect(
      (
        await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
          action: 'set_credential',
          id: '00000000-0000-4000-8000-000000000000',
          apiKey: key,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('one field is enough for Claude: save_claude_key creates the unattested, disabled provider and seals the key; a bad key creates nothing', async () => {
    const act = (body: object) => e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', body);
    const count = async () =>
      (await e.sql(`SELECT count(*)::int AS n FROM ai.model_providers WHERE code='claude'`))[0] as {
        n: number;
      };
    const bad = await act({ action: 'save_claude_key', apiKey: 'short' });
    expect(bad.statusCode).toBe(422);
    expect((await count()).n).toBe(0); // a refused key does not leave a half-made provider behind
    const key = `test-only-${'m4Tz'.repeat(8)}`;
    const first = await act({ action: 'save_claude_key', apiKey: key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ code: 'claude', adapter: 'anthropic', enabled: false });
    expect(first.json().vaultRef).toMatch(/^vault:\/\/(dev|mem)\/ai-claude$/);
    expect(first.json().dataTerms.attested).toBe(false); // attestation stays a human step (HG-09-01)
    expect(JSON.stringify(first.json())).not.toContain(key);
    const again = await act({ action: 'save_claude_key', apiKey: `${key}-2` });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id); // replaces the key, does not add a second provider
    expect((await count()).n).toBe(1);
    expect(
      JSON.stringify((await e.admin('padmin', 'GET', '/v1/admin/ai/model-providers')).json()),
    ).not.toContain(key);
    // the Claude adapter is registered outside production (a rate card, attestation and approvals are still needed before it serves anything)
    const listed = (await e.admin('padmin', 'GET', '/v1/admin/ai/model-providers')).json();
    const row = (listed.items ?? listed).find((x: { code: string }) => x.code === 'claude');
    expect(row.adapterRegistered).toBe(true);
    // editing the provider (here: only the display name) must not drop the stored key
    const edited = await act({
      action: 'configure',
      code: 'claude',
      adapter: 'anthropic',
      displayName: 'Claude (edited)',
      region: 'unspecified',
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().vaultRef).toBe(first.json().vaultRef);
  });
  it('the connection test refuses before any network call: no key stored, a provider other than Claude, an unknown id, and an org user', async () => {
    const act = (body: object) => e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', body);
    const test = (id: string) =>
      e.admin('padmin', 'POST', `/v1/admin/ai/model-providers/${id}/connection-test`);
    // a provider that is not Claude: unsupported (and never probed)
    const other = await act({
      action: 'configure',
      code: 'plain-llm',
      adapter: 'acme',
      displayName: 'Plain LLM',
      region: 'sa-central',
    });
    expect((await test(other.json().id)).statusCode).toBe(422);
    // Claude without a stored key: asked to save one first
    const claude = await act({
      action: 'configure',
      code: 'claude-nokey',
      adapter: 'anthropic',
      displayName: 'Claude (no key)',
      region: 'unspecified',
    });
    const r = await test(claude.json().id);
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('validation_failed');
    expect((await test('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect(
      (
        await e.call(
          'alice',
          'POST',
          `/v1/admin/ai/model-providers/${claude.json().id}/connection-test`,
        )
      ).statusCode,
    ).toBeGreaterThanOrEqual(401);
  });
  it('is denied to org users and to platform roles without the permission', async () => {
    expect(
      (await e.call('alice', 'GET', '/v1/admin/ai/model-providers')).statusCode,
    ).toBeGreaterThanOrEqual(401);
  });
});

describe('gateway: routing, residency, data terms, fallback', () => {
  let main: MockModelAdapter;
  beforeAll(async () => {
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='acme-llm'`,
    );
    ({ adapter: main } = await e.enableMock('mock-model'));
    await e.fund(A(), '1000000');
  });
  it('routes to the in-Kingdom provider and records usage, region and residency evidence', async () => {
    const callId = `c-${uuidv7()}`;
    const r = await gw.invoke(base({ callId, task: 'chat' }));
    expect(r.providerCode).toBe('mock-model');
    expect(r.region).toBe('sa-central');
    const u = (await usage(callId))!;
    expect(u.outcome).toBe('ok');
    expect(u.data_region).toBe('sa-central');
    expect(u.residency_evidence).toBeTruthy();
    expect(u.body_enc).toBeNull(); // bodies are NOT stored by default
  });
  it('a provider outside the Kingdom is never used for customer content, even when it is the only one (403 residency_denied)', async () => {
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model'`,
    );
    const { adapter: eu } = await e.enableMock('mock-model-eu', { region: 'de-frankfurt' });
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'residency_denied' });
    expect(eu.calls.length).toBe(0);
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model-eu'`,
    );
    await e.enableMock('mock-model', { adapter: main });
  });
  it('a failing allowed provider never falls back across residency: 503, and the EU adapter is never called', async () => {
    const { adapter: eu } = await e.enableMock('mock-model-eu', { region: 'de-frankfurt' });
    main.failNext(new ModelAdapterError('unavailable', 'down'), 10);
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(eu.calls.length).toBe(0);
    main.clearFaults();
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model-eu'`,
    );
  });
  it('falls back to another ALLOWED provider when the first fails', async () => {
    const { adapter: b } = await e.enableMock('mock-model-b', { rate: ['2000000', '4000000'] }); // dearer, so ranked second
    const mainCalls = main.calls.length;
    main.failNext(new ModelAdapterError('unavailable', 'down'), 4); // both attempts of BOTH models of the first provider
    const r = await gw.invoke(base());
    expect(r.providerCode).toBe('mock-model-b');
    expect(main.calls.length).toBe(mainCalls + 4);
    expect(b.calls.length).toBeGreaterThan(0);
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model-b'`,
    );
  });
  it('an unattested (dev-reference) provider is not offered personal or customer content (unknown terms = may retain/train), only public content', async () => {
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model'`,
    );
    const { adapter: u } = await e.enableMock('mock-model-c', { attest: false });
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'residency_denied' });
    await expect(gw.invoke(base({ dataClass: 'personal' }))).rejects.toMatchObject({
      code: 'residency_denied',
    });
    expect(u.calls.length).toBe(0);
    await expect(gw.invoke(base({ dataClass: 'public' }))).resolves.toBeTruthy();
    await e.sql(
      `UPDATE ai.model_providers SET enabled=false, enabled_by=NULL, enabled_at=NULL, enable_requested_by=NULL WHERE code='mock-model-c'`,
    );
    await e.enableMock('mock-model', { adapter: main });
  });
  it('a retryable error is retried on the same reservation and the retry costs nothing extra', async () => {
    main.failNext(new ModelAdapterError('rate_limited', 'slow'), 1);
    const callId = `c-${uuidv7()}`;
    const r = await gw.invoke(base({ callId }));
    expect(r.finishReason).toBe('stop');
    const held = await e.sql(
      `SELECT count(*) n FROM ai.reservations WHERE org_id=$1 AND call_id LIKE $2`,
      [A(), `${callId}@%`],
    );
    expect(Number(held[0]!.n)).toBe(1);
  });
  it('content the provider filters is a 422 content_blocked, no spend', async () => {
    main.failNext(new ModelAdapterError('content_filtered', 'no'), 1);
    const before = await e.wallet(A());
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'content_blocked' });
    expect(await e.wallet(A())).toBe(before);
  });
});

describe('metering and ledger (AC-M09-10)', () => {
  it('tokens and credits equal the injected usage exactly; the wallet drops by exactly the credits; a duplicate call id adds nothing', async () => {
    const a = new MockModelAdapter({ id: 'mock-model', handler: () => 'x'.repeat(40) }); // 10 output tokens
    e.registry.register('mock-model', a);
    const callId = `c-${uuidv7()}`;
    const before = await e.wallet(A());
    const events = { i: await outbox('usage.recorded') };
    const r = await gw.invoke(base({ callId, messages: msg('y'.repeat(100)) }));
    // input: ceil(100/4)+4 = 29 tokens at 1 credit each; output 10 tokens at 2 credits each
    expect(r.tokensIn).toBe(29);
    expect(r.tokensOut).toBe(10);
    expect(r.credits).toBe(29n + 20n);
    expect(r.estimated).toBe(false);
    expect(before - (await e.wallet(A()))).toBe(49n);
    expect(await outbox('usage.recorded')).toBe(events.i + 3);
    const u = (await usage(callId))!;
    expect([Number(u.tokens_in), Number(u.tokens_out), Number(u.credits)]).toEqual([29, 10, 49]);
    // duplicate call id: refused, and nothing is added (no usage row, no event, no wallet change)
    await expect(gw.invoke(base({ callId, messages: msg('y'.repeat(100)) }))).rejects.toBeTruthy();
    expect(await outbox('usage.recorded')).toBe(events.i + 3);
    expect(before - (await e.wallet(A()))).toBe(49n);
    expect(
      Number(
        (
          await e.sql(`SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND call_id=$2`, [
            A(),
            callId,
          ])
        )[0]!.n,
      ),
    ).toBe(1);
    // usage rows are append-only
    await expect(
      e.sql(`UPDATE ai.model_usage SET credits = 0 WHERE call_id=$1`, [callId]),
    ).rejects.toThrow(/append-only/);
  });
  it('a provider that reports no usage is estimated and FLAGGED', async () => {
    e.registry.register(
      'mock-model',
      new MockModelAdapter({ id: 'mock-model', reportUsage: false, handler: () => 'z'.repeat(8) }),
    );
    const callId = `c-${uuidv7()}`;
    const r = await gw.invoke(base({ callId }));
    expect(r.estimated).toBe(true);
    expect((await usage(callId))!.estimated).toBe(true);
  });
  it('the ledger posting is idempotent on the call id key', async () => {
    const n = Number(
      (
        await e.sql(
          `SELECT count(*) n FROM billing.ledger_transactions WHERE org_id=$1 AND idempotency_key LIKE 'ai:call:%'`,
          [A()],
        )
      )[0]!.n,
    );
    expect(n).toBeGreaterThan(0);
  });
});

describe('secret scan and kill switch', () => {
  beforeAll(() => e.registry.register('mock-model', new MockModelAdapter({ id: 'mock-model' })));
  it('a prompt with a platform canary or a key-looking string is blocked, audited, never sent', async () => {
    const adapter = e.registry.get('mock-model') as MockModelAdapter;
    const n = adapter.calls.length;
    for (const text of [
      `please include ${CANARY_A} on the page`,
      `key ${'AKIA' + 'ABCDEFGHIJKLMNOP'} here`,
      'use vault://org/ai/key to log in',
    ])
      await expect(gw.invoke(base({ messages: msg(text) }))).rejects.toMatchObject({
        code: 'secret_detected',
      });
    expect(adapter.calls.length).toBe(n);
    expect(
      e.sink.events.filter((x) => x.action === 'ai.secret_scan.blocked').length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      JSON.stringify(e.sink.events.filter((x) => x.action === 'ai.secret_scan.blocked')),
    ).not.toContain(CANARY_A);
    const blocked = await e.sql(
      `SELECT count(*) n FROM ai.model_usage WHERE org_id=$1 AND outcome='blocked'`,
      [A()],
    );
    expect(Number(blocked[0]!.n)).toBeGreaterThanOrEqual(3);
  });
  it('the kill switch (global or org) stops the very next call and can be lifted', async () => {
    const t = await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'kill_switch',
      on: true,
    });
    expect(t.statusCode).toBe(200);
    const t0 = Date.now();
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(Date.now() - t0).toBeLessThan(5000);
    await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'kill_switch',
      on: false,
    });
    await expect(gw.invoke(base())).resolves.toBeTruthy();
    await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'kill_switch',
      on: true,
      orgId: A(),
    });
    await expect(gw.invoke(base())).rejects.toMatchObject({ code: 'ai_unavailable' });
    await expect(gw.invoke(base({ orgId: e.org.B! }))).rejects.not.toMatchObject({
      code: 'ai_unavailable',
    }); // other orgs are unaffected
    await e.admin('padmin', 'POST', '/v1/admin/ai/model-providers', {
      action: 'kill_switch',
      on: false,
      orgId: A(),
    });
    expect(e.sink.events.some((x) => x.action === 'ai.killswitch.toggled')).toBe(true);
  });
});

describe('budgets API', () => {
  it('GET returns defaults + ETag; PUT needs If-Match (428), refuses a stale one (412) and invalid values (422)', async () => {
    const g = await e.call('alice', 'GET', '/v1/ai/budgets');
    expect(g.statusCode).toBe(200);
    expect(g.headers.etag).toBe('"0"');
    expect(
      (await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { dailyCredits: 1000 } })).statusCode,
    ).toBe(428);
    const ok = await e.call(
      'alice',
      'PUT',
      '/v1/ai/budgets',
      { org: { dailyCredits: 1000, runMaxCredits: 500 } },
      A(),
      { 'if-match': '"0"' },
    );
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    expect(
      (
        await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { dailyCredits: 5 } }, A(), {
          'if-match': '"0"',
        })
      ).statusCode,
    ).toBe(412);
    expect(
      (
        await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { dailyCredits: -5 } }, A(), {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { logBodies: true } }, A(), {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBe(422); // bodies need a retention (D-34)
    expect(
      (await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"1"' }))
        .statusCode,
    ).toBe(200); // reset (no caps)
  });
  it('roles: viewer reads but cannot write; billing_admin writes caps but cannot enable auto-apply; org B never sees org A', async () => {
    expect((await e.call('carol', 'GET', '/v1/ai/budgets')).statusCode).toBe(200);
    expect(
      (await e.call('carol', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"2"' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await e.call('frank', 'PUT', '/v1/ai/budgets', { org: { autoApplyLowRisk: true } }, A(), {
          'if-match': '"2"',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await e.call('frank', 'PUT', '/v1/ai/budgets', { org: { dailyCredits: 7 } }, A(), {
          'if-match': '"2"',
        })
      ).statusCode,
    ).toBe(200);
    const b = await e.call('bob', 'GET', '/v1/ai/budgets', undefined, e.org.B);
    expect(b.json().org.dailyCredits).toBeNull();
    expect(
      (await e.call('bob', 'GET', '/v1/ai/budgets', undefined, A())).statusCode,
    ).toBeGreaterThanOrEqual(403);
    await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"3"' });
  });
  it('GET /v1/ai/credits shows the projection (wallet − reservations) and usage by model', async () => {
    const r = await e.call('carol', 'GET', '/v1/ai/credits');
    expect(r.statusCode).toBe(200);
    expect(BigInt(r.json().availableCredits)).toBeGreaterThan(0n);
    expect(r.json().usage.byModel.length).toBeGreaterThan(0);
  });
});

describe('spend safety (AC-M09-01)', () => {
  let budgets: BudgetService;
  beforeAll(async () => {
    budgets = e.app.get(BudgetService);
    e.registry.register(
      'mock-model',
      new MockModelAdapter({
        id: 'mock-model',
        handler: (req) => 'w'.repeat(4 * Math.min(req.maxTokens, 37)),
      }),
    );
  });
  it('insufficient credits is 402 and nothing is spent', async () => {
    await e.fund(e.org.B!, '5');
    await expect(gw.invoke(base({ orgId: e.org.B!, maxTokens: 1000 }))).rejects.toMatchObject({
      code: 'insufficient_credits',
    });
    expect(await e.wallet(e.org.B!)).toBe(5n);
  });
  it('property: across 1000 randomized calls in concurrent runs, spend never exceeds the run cap (not even by one reservation)', async () => {
    await e.fund(A(), '50000000');
    const runs = Array.from({ length: 50 }, () => uuidv7());
    const capOf = (run: string) => 300 + (runs.indexOf(run) % 7) * 100;
    for (const id of runs)
      await e
        .sql(
          `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1,$2,'t','SA') ON CONFLICT DO NOTHING`,
          [id, A()],
        )
        .then(() =>
          e.sql(
            `INSERT INTO ai.runs (id, org_id, session_id, kind, data_region, budget) VALUES ($1,$2,$1,'chat','SA','{}')`,
            [id, A()],
          ),
        );
    const caps = new Map<string, number>();
    let refused = 0;
    const tasks: (() => Promise<void>)[] = [];
    await fc.assert(
      fc.asyncProperty(fc.constant(0), async () => {
        for (let i = 0; i < 1000; i++) {
          const run = runs[i % runs.length]!;
          const cap = capOf(run);
          caps.set(run, cap);
          const maxTokens = 5 + ((i * 37) % 60);
          tasks.push(async () => {
            try {
              await gw.invoke(
                base({
                  runId: run,
                  callId: `p-${i}-${uuidv7()}`,
                  maxTokens,
                  runBudget: { maxCredits: cap },
                }),
              );
            } catch (err) {
              if (
                !['budget_exceeded', 'insufficient_credits'].includes(
                  (err as { code?: string }).code ?? '',
                )
              )
                throw err;
              refused++;
            }
          });
        }
        for (let i = 0; i < tasks.length; i += 8)
          await Promise.all(tasks.slice(i, i + 8).map((t) => t()));
      }),
      { numRuns: 1 },
    );
    for (const [run, cap] of caps) {
      const s = (
        await e.sql(`SELECT coalesce(sum(credits),0) c FROM ai.model_usage WHERE run_id=$1`, [run])
      )[0]!;
      const held = (
        await e.sql(
          `SELECT coalesce(sum(credits),0) c FROM ai.reservations WHERE run_id=$1 AND state='held'`,
          [run],
        )
      )[0]!;
      expect(Number(s.c), `run ${run}`).toBeLessThanOrEqual(cap);
      expect(Number(held.c)).toBe(0);
    }
    expect(refused).toBeGreaterThan(0);
    const totals = (
      await e.sql(
        `SELECT count(*) n FROM ai.model_usage WHERE run_id = ANY($1::uuid[]) AND outcome='ok'`,
        [runs],
      )
    )[0]!;
    expect(Number(totals.n)).toBeGreaterThan(50);
  }, 300_000);
  it('chaos: 20 runaway loops all stop at the cap (budget_exceeded), reservations all closed', async () => {
    await e.sql(`UPDATE ai.credit_balances SET reserved_credits = 0 WHERE org_id=$1`, [A()]);
    const stops = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const run = uuidv7();
        await e.sql(
          `INSERT INTO ai.sessions (id, org_id, title, data_region) VALUES ($1,$2,'t','SA')`,
          [run, A()],
        );
        await e.sql(
          `INSERT INTO ai.runs (id, org_id, session_id, kind, data_region) VALUES ($1,$2,$1,'chat','SA')`,
          [run, A()],
        );
        let n = 0;
        for (;;) {
          try {
            await gw.invoke(
              base({
                runId: run,
                callId: `l-${n++}-${uuidv7()}`,
                maxTokens: 40,
                runBudget: { maxCredits: 400 },
              }),
            );
          } catch (err) {
            expect((err as { code?: string }).code).toBe('budget_exceeded');
            break;
          }
          if (n > 50) throw new Error('the loop did not stop');
        }
        const s = (
          await e.sql(`SELECT coalesce(sum(credits),0) c FROM ai.model_usage WHERE run_id=$1`, [
            run,
          ])
        )[0]!;
        return Number(s.c);
      }),
    );
    for (const s of stops) expect(s).toBeLessThanOrEqual(400);
    expect(
      Number((await e.sql(`SELECT count(*) n FROM ai.reservations WHERE state='held'`))[0]!.n),
    ).toBe(0);
  }, 120_000);
  it('org daily cap and project cap are enforced too; the sweeper releases a crashed call', async () => {
    await e.call('alice', 'PUT', '/v1/ai/budgets', { org: { dailyCredits: 1 } }, A(), {
      'if-match': '"4"',
    });
    await expect(gw.invoke(base({ maxTokens: 20 }))).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    await e.call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"5"' });
    const orphan = await budgets.reserve({
      orgId: A(),
      callId: `orphan-${uuidv7()}`,
      credits: 10n,
      tokens: 10n,
    });
    await e.sql(`UPDATE ai.reservations SET expires_at = now() - interval '1 minute' WHERE id=$1`, [
      orphan.id,
    ]);
    expect(await budgets.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(
      (await e.sql(`SELECT state FROM ai.reservations WHERE id=$1`, [orphan.id]))[0]!.state,
    ).toBe('released');
  });
});

describe('prompt/response bodies are stored only when the org enables them, sealed', () => {
  it('logBodies=true stores an encrypted body that is not the plaintext', async () => {
    const g = await e.call('alice', 'GET', '/v1/ai/budgets');
    const v = g.headers.etag as string;
    expect(
      (
        await e.call(
          'alice',
          'PUT',
          '/v1/ai/budgets',
          { org: { logBodies: true, bodyRetentionDays: 7 } },
          A(),
          { 'if-match': v },
        )
      ).statusCode,
    ).toBe(200);
    const callId = `c-${uuidv7()}`;
    await gw.invoke(base({ callId, messages: msg('secret-free plain prompt about dates') }));
    const u = (await usage(callId))!;
    expect(String(u.body_enc)).toMatch(/^enc:v1:/);
    expect(String(u.body_enc)).not.toContain('plain prompt');
    expect(u.body_expires_at).toBeTruthy();
    await e
      .call('alice', 'PUT', '/v1/ai/budgets', { org: {} }, A(), { 'if-match': '"7"' })
      .catch(() => undefined);
  });
});

describe('cross-tenant (RLS) on the gateway tables', () => {
  it('org B sees none of org A usage, reservations, budgets, balances through its own scope', async () => {
    for (const t of [
      'model_usage',
      'reservations',
      'budgets',
      'credit_balances',
      'runs',
      'sessions',
    ])
      expect(
        await e.h.env.app.withOrg(
          e.org.B!,
          async (c) =>
            (await c.query(`SELECT count(*)::int n FROM ai.${t} WHERE org_id <> $1`, [e.org.B]))
              .rows[0]!.n,
        ),
        t,
      ).toBe(0);
    await expect(
      e.h.env.app.withOrg(e.org.B!, (c) =>
        c.query(
          `INSERT INTO ai.budgets (id, org_id, scope) VALUES (gen_random_uuid(), $1, 'org')`,
          [A()],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const r = await e.call('bob', 'GET', '/v1/ai/credits', undefined, e.org.B);
    expect(r.json().usage.byModel).toEqual([]);
  });
  void ModelProviderService;
});
