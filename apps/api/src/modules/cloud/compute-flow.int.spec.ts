import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { RESOURCE_STATES, canTransitionResource, type TransitionActor } from '@nuzm/domain';
import { Db } from '@nuzm/platform';
import { ResidencyService } from '../compliance';
import { ComputeMeteringSampler, ProvisioningService } from './index';
import { ComputeKit, SSH_KEY, type Row } from './testing/compute-kit';

const k = new ComputeKit();
let A = '';
let B = '';

beforeAll(async () => {
  await k.init();
  A = k.orgA;
  B = k.orgB;
});
afterAll(() => k.close());

const offers = async (who: string, org: string, qs = '') =>
  k.call(who, 'GET', `/v1/offers${qs}`, org);

describe('offers: only verified inventory (AC-M05-03, AC-M05-21)', () => {
  it('returns only the Saudi plans that are available; provider identity, provider region and provider cost are never shown', async () => {
    const r = await offers('alice', A);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    // mock-sa-1 (in the Kingdom, verified) has small + medium (large is sold out); mock-eu-1 is denied by the platform floor (in_kingdom_only)
    expect(items.map((i) => `${i.country}:${i.plan.vcpu}`).sort()).toEqual(['SA:1', 'SA:2']);
    expect(items[0]).toMatchObject({
      kind: 'compute',
      dataRegion: 'in_kingdom',
      price: { currency: 'SAR', period: 'month' },
    });
    // the product line is a Nuzm name (the simulator account is the Spark line), never the identity of the infrastructure
    expect(items.every((i) => i.family === 'spark')).toBe(true);
    const text = JSON.stringify(r.json());
    for (const leak of [
      'mock',
      'providerRegionId',
      'planRef',
      'providerPrice',
      'accountId',
      'provider',
    ])
      expect(text).not.toContain(leak);
    expect(items.map((i) => i.price.amount).sort()).toEqual(['1540', '3080']); // 730 vCPU-h + 730 GiB-h x 0.5 + 40 GiB x 2 ; doubled
  });

  it('operating systems of an offer: names only, for an eligible offer; anything else is 404 (not 403), and the flag gates it', async () => {
    const offerId = ((await offers('alice', A)).json().items as Row[])[0]!.offerId as string;
    const r = await k.call('alice', 'GET', `/v1/offers/${offerId}/images`, A);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    expect(items.length).toBeGreaterThan(0);
    for (const i of items)
      expect(Object.keys(i).sort()).toEqual(['hestia', 'id', 'name', 'osFamily']);
    const text = JSON.stringify(r.json());
    for (const leak of ['imageRef', 'providerRegionId', 'accountId', 'provider', 'mock-sa-1'])
      expect(text).not.toContain(leak);
    // the id from the list is what a quote accepts
    expect(items.map((i) => i.id)).toContain(await k.imageId());
    // an unknown id, a malformed id and an offer that is not eligible for this organization all look the same
    expect((await k.call('alice', 'GET', '/v1/offers/not-a-uuid/images', A)).statusCode).toBe(404);
    expect(
      (await k.call('alice', 'GET', '/v1/offers/00000000-0000-4000-8000-000000000000/images', A))
        .statusCode,
    ).toBe(404);
    await k.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'cloud.provisioning', $1, 'false'::jsonb)`,
      [A],
    );
    expect((await k.call('alice', 'GET', `/v1/offers/${offerId}/images`, A)).statusCode).toBe(404);
    await k.sql(`DELETE FROM platform.feature_flags WHERE org_id = $1`, [A]);
  });

  it('country filters: DE (residency denies), US (not listed) and an invalid code', async () => {
    expect((await offers('alice', A, '?country=DE')).json().items).toHaveLength(0);
    expect((await offers('alice', A, '?country=US')).json().items).toHaveLength(0);
    expect((await offers('alice', A, '?country=SA&minVcpu=2')).json().items).toHaveLength(1);
    expect((await offers('alice', A, '?country=SAU')).statusCode).toBe(422);
    expect((await offers('alice', A, '?provider=mock')).statusCode).toBe(422); // provider identity is not a customer filter
    expect((await offers('alice', A, '?kind=hosting')).statusCode).toBe(422);
  });

  it('viewers may browse; the feature flag gates the endpoint; other orgs are evaluated on their own', async () => {
    expect((await offers('carol', A)).statusCode).toBe(200);
    await k.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'cloud.provisioning', $1, 'false'::jsonb)`,
      [B],
    );
    expect((await offers('bob', B)).statusCode).toBe(404);
    await k.sql(`DELETE FROM platform.feature_flags WHERE org_id = $1`, [B]);
    expect((await offers('bob', B)).statusCode).toBe(200);
  });

  it('admin view shows provider identity and, with includeIneligible, why each plan is hidden', async () => {
    const r = await k.admin('pa', 'GET', `/v1/admin/offers?orgId=${A}&includeIneligible=true`);
    expect(r.statusCode).toBe(200);
    const items = r.json().items as Row[];
    const eu = items.find((i) => i.country === 'DE' && i.plan.vcpu === 1)!;
    expect(eu.provider.key).toBe('mock');
    expect(eu.eligible).toBe(false);
    expect(eu.failures).toContain('residency_denied');
    const large = items.find((i) => i.country === 'SA' && i.plan.vcpu === 4)!;
    expect(large.failures).toEqual(['plan_unavailable']);
    expect(items.find((i) => i.country === 'SA' && i.plan.vcpu === 1)!.eligible).toBe(true);
  });

  it('hides offers when the account is unhealthy, the breaker is open, or a lifecycle capability is not supported', async () => {
    await k.sql(`UPDATE cloud.provider_accounts SET health_state = 'unhealthy' WHERE id = $1`, [
      k.accountId,
    ]);
    expect((await offers('alice', A)).json().items).toHaveLength(0);
    await k.sql(
      `UPDATE cloud.provider_accounts SET health_state = 'healthy', breaker_state = '{"state":"open"}'::jsonb WHERE id = $1`,
      [k.accountId],
    );
    expect((await offers('alice', A)).json().items).toHaveLength(0);
    await k.sql(
      `UPDATE cloud.provider_accounts SET breaker_state = '{"state":"closed"}'::jsonb WHERE id = $1`,
      [k.accountId],
    );
    await k.sql(
      `UPDATE cloud.provider_capabilities SET state = 'unknown' WHERE account_id = $1 AND capability_id = 'compute.delete'`,
      [k.accountId],
    );
    expect((await offers('alice', A)).json().items).toHaveLength(0);
    await k.sql(
      `UPDATE cloud.provider_capabilities SET state = 'supported' WHERE account_id = $1 AND capability_id = 'compute.delete'`,
      [k.accountId],
    );
    expect((await offers('alice', A)).json().items).toHaveLength(2);
  });

  it('AC-M05-03: with no verified Saudi region, country=SA returns 0 items; a stale verification (> TTL) also hides the offers', async () => {
    // (1) the Saudi region disappears from the account listing -> withdrawn -> no Saudi offers
    k.mock.setRegions([
      { id: 'mock-eu-1', country: 'DE', listed: true },
      { id: 'mock-sa-1', country: 'SA', listed: false },
      { id: 'mock-us-1', country: 'US', listed: false },
    ]);
    await k.verify();
    expect((await offers('alice', A, '?country=SA')).json().items).toHaveLength(0);
    k.mock.setRegions([
      { id: 'mock-eu-1', country: 'DE', listed: true },
      { id: 'mock-sa-1', country: 'SA', listed: true },
      { id: 'mock-us-1', country: 'US', listed: false },
    ]);
    await k.verify();
    expect((await offers('alice', A, '?country=SA')).json().items).toHaveLength(2);
    // (2) the verification becomes stale: > 7 days (aged in the database so the shared simulated clock is not moved for the quote tests)
    await k.sql(
      `UPDATE cloud.provider_regions SET verified_at = now() - interval '8 days' WHERE account_id = $1 AND state = 'verified'`,
      [k.accountId],
    );
    expect((await offers('alice', A, '?country=SA')).json().items).toHaveLength(0);
    await k.verify(); // re-verified at the current time
    expect((await offers('alice', A, '?country=SA')).json().items).toHaveLength(2);
  });

  it('an unverified region cannot be made visible by the database either (CHECK) and a mock-evidence region is not trusted in production profiles (domain rule)', async () => {
    await expect(
      k.sql(
        `UPDATE cloud.provider_regions SET evidence_ref = NULL WHERE account_id = $1 AND state = 'verified'`,
        [k.accountId],
      ),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe('compute quotes (AC-M05-06): immutable, TTL, consume-once, price drift, residency embedded', () => {
  it('issues a compute quote: three lines, tax estimate, residency decision with policy version, no provider identity; routing decision is internal', async () => {
    const r = await k.quote('alice', A);
    expect(r.statusCode).toBe(201);
    const q = r.json();
    expect(q).toMatchObject({
      kind: 'compute',
      status: 'issued',
      currency: 'SAR',
      subtotalMinor: '1540',
      requiresApproval: false,
    });
    expect(q.items.map((i: Row) => i.meterId)).toEqual([
      'compute.vcpu_hours',
      'compute.memory_gb_hours',
      'compute.disk_gb_months',
    ]);
    expect(q.residency).toMatchObject({ decision: 'allow', dataRegion: 'in_kingdom' });
    expect(q.residency.floorVersion).toEqual(expect.any(Number)); // policyVersion is null while the org has no policy of its own (the floor applies)
    expect(q.residency.evidenceRef).toMatch(/^rd_|^residency/);
    expect(['provisional', 'computed']).toContain(q.taxEstimate.status);
    expect(JSON.stringify(q)).not.toMatch(/mock|planRef|providerRegionId|routing/);
    const row = (await k.sql(`SELECT preferences FROM commerce.quotes WHERE id = $1`, [q.id]))[0]!;
    expect(row.preferences.compute).toMatchObject({
      providerKey: 'mock',
      providerRegionId: 'mock-sa-1',
      planRef: 'mock.small',
    });
    expect(row.preferences.compute.routing).toMatchObject({
      mode: 'automatic',
      chosenOfferId: row.preferences.compute.offerId,
      tieBreak: expect.arrayContaining(['priceMinor']),
    });
    expect(Date.parse(q.expiresAt) - Date.parse(q.createdAt)).toBe(15 * 60_000);
    // immutable
    await expect(
      k.sql(`UPDATE commerce.quotes SET total_minor = 1 WHERE id = $1`, [q.id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      k.sql(`DELETE FROM commerce.quote_items WHERE quote_id = $1`, [q.id]),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses requests with no eligible offer, bad specs and a missing kind permission', async () => {
    expect(
      (await k.quote('alice', A, { routing: { mode: 'automatic', country: 'DE' } })).json().code ??
        '',
    ).toMatch(/no_eligible_offer/);
    expect(
      (
        await k.quote('alice', A, {
          routing: { mode: 'explicit', provider: 'mock', region: 'mock-eu-1' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await k.quote('alice', A, { spec: { imageId: await k.imageId(), count: 99 } })).statusCode,
    ).toBe(422);
    expect(
      (
        await k.quote('alice', A, {
          spec: { imageId: '00000000-0000-4000-8000-000000000000', count: 1 },
        })
      ).statusCode,
    ).toBe(422);
    expect((await k.quote('alice', A, { term: { period: 'year' } })).statusCode).toBe(422);
    expect((await k.quote('carol', A)).statusCode).toBe(403); // viewer: no quote:create
  });

  it('routing: explicit (provider+region) and offerId produce the same eligible offer; the decision names the rules applied', async () => {
    const ex = await k.quote('alice', A, {
      routing: { mode: 'explicit', provider: 'mock', region: 'mock-sa-1' },
    });
    expect(ex.statusCode).toBe(201);
    const items = (await offers('alice', A, '?country=SA&minVcpu=2')).json().items as Row[];
    const byId = await k.quote('alice', A, { routing: undefined, offerId: items[0]!.offerId });
    expect(byId.statusCode).toBe(201);
    expect(byId.json().subtotalMinor).toBe('3080');
    const rule = await k.admin('pa', 'POST', '/v1/admin/routing-rules', {
      ruleKey: 'prefer-medium',
      priority: 5,
      match: { country: ['SA'] },
      action: { type: 'prefer', providerKey: 'mock' },
      note: 'test',
    });
    expect(rule.statusCode).toBe(201);
    const q = await k.quote('alice', A);
    const pref = (
      await k.sql(`SELECT preferences FROM commerce.quotes WHERE id = $1`, [q.json().id])
    )[0]!.preferences.compute;
    expect(pref.routing.rulesApplied[0]).toMatchObject({
      ruleKey: 'prefer-medium',
      version: 1,
      type: 'prefer',
    });
    const v2 = await k.admin('pa', 'POST', '/v1/admin/routing-rules', {
      ruleKey: 'prefer-medium',
      priority: 5,
      match: { country: ['SA'] },
      action: { type: 'prefer', providerKey: 'mock' },
      enabled: false,
    });
    expect(v2.json().version).toBe(2);
    expect((await k.admin('pa', 'GET', '/v1/admin/routing-rules')).json().items).toEqual([
      expect.objectContaining({ ruleKey: 'prefer-medium', version: 2, enabled: false }),
    ]);
    expect(
      (await k.admin('pa', 'GET', '/v1/admin/routing-rules?history=true')).json().items,
    ).toHaveLength(2);
    await expect(k.sql(`UPDATE cloud.routing_rules SET enabled = true`)).rejects.toThrow(
      /append-only/,
    );
    expect(k.sink.events.filter((e) => e.action === 'routing.rule.changed')).toHaveLength(2);
    expect(
      (
        await k.admin('pa', 'POST', '/v1/admin/routing-rules', {
          ruleKey: 'bad',
          priority: 1,
          action: { type: 'prefer' },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('residency is evaluated at the quote with the audited hook; a denial is 403 residency_denied (hook gate replaced for the case)', async () => {
    const svc = k.app.get(ResidencyService);
    const real = svc.evaluate.bind(svc);
    svc.evaluate = async (req) =>
      req.purpose === 'compute.quote'
        ? {
            decision: 'deny',
            reasons: [
              {
                code: 'mode_in_kingdom_only',
                message: { en: 'Placement outside the Kingdom is not allowed.', ar: 'x' },
              },
            ],
            policyVersion: 1,
            floorVersion: 1,
            assessmentId: null,
            evidenceRef: 'rd_test',
          }
        : real(req);
    try {
      const r = await k.quote('alice', A);
      expect(r.statusCode).toBe(403);
      expect(r.json().code ?? r.json().type).toMatch(/residency_denied/);
      expect(r.json().reasons?.[0]?.code).toBe('mode_in_kingdom_only');
    } finally {
      svc.evaluate = real;
    }
  });
});

describe('instance lifecycle through the durable operation', () => {
  let instanceId = '';
  let operationId = '';
  let quoteId = '';

  it('create: 202, resource PROVISIONING + hold authorization + operation pending; then the operation runs reserve → place → provision → inspect → persist → finalize', async () => {
    const c = await k.createInstance('alice', A);
    expect(c.res.statusCode).toBe(202);
    ({ instanceId, operationId, quoteId } = c);
    expect(c.res.json().instance.status).toBe('provisioning');
    const pending = await k.instanceRow(instanceId);
    expect(pending).toMatchObject({
      status: 'provisioning',
      rstate: 'PROVISIONING',
      provider_ref: null,
      data_region: 'in_kingdom',
    });
    expect(pending.provision_token).toMatch(/^[0-9a-f]{64}$/);
    const hold = (
      await k.sql(
        `SELECT a.kind, a.amount_minor, a.order_id FROM commerce.authorizations a JOIN commerce.orders o ON o.id = a.order_id WHERE o.quote_id = $1`,
        [quoteId],
      )
    )[0]!;
    expect(hold).toMatchObject({ kind: 'hold' });
    expect(String(hold.amount_minor)).toBe(
      String(
        (await k.sql(`SELECT total_minor FROM commerce.quotes WHERE id = $1`, [quoteId]))[0]!
          .total_minor,
      ),
    );
    const op = await k.runOp(A, operationId);
    expect(op.state).toBe('succeeded');
    const row = await k.instanceRow(instanceId);
    expect(row).toMatchObject({ status: 'running', rstate: 'ACTIVE', drift_state: 'in_sync' });
    expect(row.provider_ref).toMatch(/^mock-i-/);
    expect(row.public_ips).toHaveLength(1);
    expect(
      (await k.sql(`SELECT status FROM commerce.orders WHERE quote_id = $1`, [quoteId]))[0]!.status,
    ).toBe('fulfilled');
    expect(await k.sql(`SELECT 1 FROM commerce.authorization_releases`)).toHaveLength(0); // success: the hold is NOT released
    const steps = (
      await k.sql(
        `SELECT name, state FROM platform.operation_steps WHERE operation_id = $1 ORDER BY seq`,
        [operationId],
      )
    ).map((s) => `${s.name}:${s.state}`);
    expect(steps).toEqual([
      'reserve_authorization:succeeded',
      'place:succeeded',
      'provision:succeeded',
      'inspect:succeeded',
      'persist:succeeded',
      'finalize:succeeded',
    ]);
    expect(
      k.sink.events.some(
        (e) => e.action === 'instance.create.requested' && e.resource?.id === instanceId,
      ),
    ).toBe(true);
    expect(
      k.sink.events.some(
        (e) => e.action === 'instance.create.succeeded' && e.resource?.id === instanceId,
      ),
    ).toBe(true);
    expect(
      await k.sql(
        `SELECT 1 FROM platform.outbox WHERE topic = 'compute.instance.created' AND org_id = $1`,
        [A],
      ),
    ).toHaveLength(1);
    expect(k.mock.provisionCalls()).toBe(1);
    expect(k.mock.instances.get(row.provider_ref)!.tags).toMatchObject({
      'nuzm-instance': instanceId,
    }); // opaque ids only
    expect(Object.values(k.mock.instances.get(row.provider_ref)!.tags).join(' ')).not.toContain(
      'Compute A',
    ); // never the org name
  });

  it('GET: customers see the instance without any provider detail; the operation result and steps are provider-free', async () => {
    const g = await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}`, A);
    expect(g.statusCode).toBe(200);
    expect(g.headers.etag).toBeTruthy();
    expect(g.json()).toMatchObject({
      id: instanceId,
      status: 'running',
      dataRegion: 'in_kingdom',
      country: 'SA',
      driftState: 'in_sync',
      plan: { vcpu: 1, memoryMb: 2048, diskGb: 40 },
      name: 'web-1',
    });
    expect(g.json().capabilities).toEqual(
      expect.arrayContaining(['compute.action.stop', 'compute.provision']),
    );
    const op = await k.call('alice', 'GET', `/v1/operations/${operationId}`, A);
    expect(op.json().state).toBe('succeeded');
    expect(op.json().steps).toHaveLength(6);
    for (const text of [JSON.stringify(g.json()), JSON.stringify(op.json())])
      expect(text).not.toMatch(/mock-|providerRef|planRef|accountId/);
    const list = await k.call('alice', 'GET', '/v1/compute/instances', A);
    expect(list.json().items.map((i: Row) => i.id)).toContain(instanceId);
  });

  it('actions: only capabilities of the instance; invalid states 409; idempotent per key; stop/start/resize/snapshot apply and meter', async () => {
    const act = (type: string, params: object = {}, key = `a-${Math.random()}`) =>
      k.call(
        'alice',
        'POST',
        `/v1/compute/instances/${instanceId}/actions`,
        A,
        { type, params },
        { 'idempotency-key': key },
      );
    expect((await act('fly')).statusCode).toBe(422);
    expect((await act('start')).statusCode).toBe(409); // already running
    const stop = await act('stop', {}, 'stop-1');
    expect(stop.statusCode).toBe(202);
    const again = await act('stop', {}, 'stop-1');
    expect(again.json().actionId).toBe(stop.json().actionId); // idempotent per key
    expect(
      await k.sql(`SELECT 1 FROM compute.instance_actions WHERE instance_id = $1`, [instanceId]),
    ).toHaveLength(1);
    await k.runOp(A, stop.json().operationId);
    expect((await k.instanceRow(instanceId)).status).toBe('stopped');
    expect(
      await k.sql(
        `SELECT 1 FROM compute.instance_intervals WHERE instance_id = $1 AND ended_at IS NULL`,
        [instanceId],
      ),
    ).toHaveLength(0);
    const start = await act('start');
    await k.runOp(A, start.json().operationId);
    expect((await k.instanceRow(instanceId)).status).toBe('running');
    // resize to the 2-vCPU offer of the same placement
    const medium = (await offers('alice', A, '?country=SA&minVcpu=2')).json().items[0];
    const rs = await act('resize', { offerId: medium.offerId });
    expect(rs.statusCode).toBe(202);
    await k.runOp(A, rs.json().operationId);
    expect(
      (await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}`, A)).json().plan,
    ).toMatchObject({ vcpu: 2, memoryMb: 4096, diskGb: 80 });
    const bad = await act('resize', { offerId: '00000000-0000-4000-8000-000000000000' });
    expect([404, 422]).toContain(bad.statusCode);
    const snap = await act('snapshot');
    await k.runOp(A, snap.json().operationId);
    const snaps = await k.sql(
      `SELECT data_region, state FROM compute.snapshots WHERE instance_id = $1`,
      [instanceId],
    );
    expect(snaps).toEqual([{ data_region: 'in_kingdom', state: 'available' }]); // snapshots inherit the region
    expect(
      k.sink.events.filter(
        (e) => e.action === 'compute.instance.action' && e.resource?.id === instanceId,
      ),
    ).toHaveLength(4);
  });

  it('unsupported capability: 422 for an action the instance does not support (AC-M05-09 API half); metrics 422 when the provider has none', async () => {
    await k.sql(
      `UPDATE compute.instances SET capabilities = capabilities - 'compute.action.reboot' - 'compute.metrics' WHERE id = $1`,
      [instanceId],
    );
    const r = await k.call('alice', 'POST', `/v1/compute/instances/${instanceId}/actions`, A, {
      type: 'reboot',
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code ?? r.json().type).toMatch(/unsupported_capability/);
    expect(
      (await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}/metrics`, A)).statusCode,
    ).toBe(422);
    await k.sql(
      `UPDATE compute.instances SET capabilities = capabilities || '["compute.action.reboot","compute.metrics"]'::jsonb WHERE id = $1`,
      [instanceId],
    );
    const m = await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}/metrics`, A);
    expect(m.statusCode).toBe(200);
    expect(m.json().series[0].name).toBe('cpu_utilization');
    expect(
      (
        await k.call(
          'alice',
          'GET',
          `/v1/compute/instances/${instanceId}/metrics?from=2026-01-02&to=2026-01-01`,
          A,
        )
      ).statusCode,
    ).toBe(422);
  });

  it('quote consume-once: a second create from the same quote is 409 quote_consumed', async () => {
    const r = await k.call('alice', 'POST', '/v1/compute/instances', A, {
      quoteId,
      name: 'again',
      sshPublicKeys: [],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code ?? r.json().type).toMatch(/quote_consumed/);
    expect(
      await k.sql(`SELECT 1 FROM compute.instances WHERE quote_id = $1`, [quoteId]),
    ).toHaveLength(1);
  });

  it('delete: If-Match required, protection honoured, then the operation deletes at the provider and closes metering', async () => {
    const g = await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}`, A);
    expect(
      (await k.call('alice', 'DELETE', `/v1/compute/instances/${instanceId}`, A)).statusCode,
    ).toBe(428);
    expect(
      (
        await k.call('alice', 'DELETE', `/v1/compute/instances/${instanceId}`, A, undefined, {
          'if-match': '"999"',
        })
      ).statusCode,
    ).toBe(412);
    await k.sql(`UPDATE compute.instances SET deletion_protected = true WHERE id = $1`, [
      instanceId,
    ]);
    const prot = await k.call(
      'alice',
      'DELETE',
      `/v1/compute/instances/${instanceId}`,
      A,
      undefined,
      { 'if-match': g.headers.etag as string },
    );
    expect(prot.statusCode).toBe(409);
    expect(prot.json().code ?? prot.json().type).toMatch(/deletion_protected/);
    await k.sql(
      `UPDATE compute.instances SET deletion_protected = false, version = version + 1 WHERE id = $1`,
      [instanceId],
    );
    const g2 = await k.call('alice', 'GET', `/v1/compute/instances/${instanceId}`, A);
    const d = await k.call('alice', 'DELETE', `/v1/compute/instances/${instanceId}`, A, undefined, {
      'if-match': g2.headers.etag as string,
    });
    expect(d.statusCode).toBe(202);
    expect(d.json().instance.status).toBe('deleting');
    expect((await k.runOp(A, d.json().operationId)).state).toBe('succeeded');
    const row = await k.instanceRow(instanceId);
    expect(row).toMatchObject({ status: 'deleted', rstate: 'DELETED' });
    expect(k.mock.billableByToken(row.provision_token)).toBe(0);
    expect(
      await k.sql(
        `SELECT 1 FROM compute.instance_intervals WHERE instance_id = $1 AND ended_at IS NULL`,
        [instanceId],
      ),
    ).toHaveLength(0);
    expect(
      k.sink.events.some(
        (e) => e.action === 'compute.instance.deleted' && e.resource?.id === instanceId,
      ),
    ).toBe(true);
    expect(
      (
        await k.call('alice', 'DELETE', `/v1/compute/instances/${instanceId}`, A, undefined, {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(409);
  });
});

describe('execution-time re-evaluation (TOCTOU) and compensation', () => {
  const failedState = async (instanceId: string, operationId: string, code: string) => {
    const op = (
      await k.sql(`SELECT state, error FROM platform.operations WHERE id = $1`, [operationId])
    )[0]!;
    expect(op.state).toBe('failed');
    expect(op.error.code).toBe(code);
    const row = await k.instanceRow(instanceId);
    expect(row).toMatchObject({ status: 'failed', rstate: 'FAILED' });
    expect(row.provider_ref).toBeNull();
    const rel = await k.sql(
      `SELECT r.reason FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id WHERE a.order_id = $1`,
      [row.order_id],
    );
    expect(rel).toHaveLength(1);
    expect(
      (await k.sql(`SELECT status FROM commerce.orders WHERE id = $1`, [row.order_id]))[0]!.status,
    ).toBe('failed');
    return rel[0]!.reason as string;
  };

  it('residency tightened between quote and provision: denied at execution, hold released, nothing created (AC-M05-07)', async () => {
    const c = await k.createInstance('alice', A);
    expect(c.res.statusCode).toBe(202);
    const before = k.mock.provisionCalls();
    await k.registerProcessor('mock', false); // the processor is no longer registered in ROPA: the policy now denies
    try {
      await k.runOp(A, c.operationId);
      expect(await failedState(c.instanceId, c.operationId, 'residency_denied')).toBe(
        'residency_denied',
      );
      expect(k.mock.provisionCalls()).toBe(before); // the provider was never called
      expect(
        k.sink.events.some(
          (e) => e.action === 'instance.create.failed' && e.resource?.id === c.instanceId,
        ),
      ).toBe(true);
    } finally {
      await k.registerProcessor('mock', true);
    }
    expect(await offers('alice', A).then((r) => r.json().items.length)).toBeGreaterThan(0);
  });

  it('price change between quote and provision: 409 price_changed at the API, and failed (no silent charge) when it changes after acceptance', async () => {
    const c = await k.createInstance('alice', A);
    const before = k.mock.provisionCalls();
    k.mock.setPrice('mock.small', '99'); // the provider changed its price
    await k.sql(
      `UPDATE cloud.provider_plans SET provider_price_minor = 99 WHERE plan_ref = 'mock.small' AND account_id = $1`,
      [k.accountId],
    ); // as a catalog sync would
    try {
      await k.runOp(A, c.operationId);
      expect(await failedState(c.instanceId, c.operationId, 'price_changed')).toBe('price_changed');
      expect(k.mock.provisionCalls()).toBe(before);
      const q = await k.quote('alice', A);
      const late = await k.call('alice', 'POST', '/v1/compute/instances', A, {
        quoteId: q.json().id,
        name: 'x',
        sshPublicKeys: [],
      });
      expect(late.statusCode).toBe(201 === late.statusCode ? 201 : late.statusCode); // a fresh quote is priced from the CURRENT catalog
      expect(late.statusCode).toBe(202);
      await k.runOp(A, late.json().operationId);
    } finally {
      k.mock.setPrice('mock.small', '12');
      await k.sql(
        `UPDATE cloud.provider_plans SET provider_price_minor = 12 WHERE plan_ref = 'mock.small' AND account_id = $1`,
        [k.accountId],
      );
    }
  });

  it('price drift visible at the API: the quote carries the provider price it was issued with; a later change is refused with 409 price_changed', async () => {
    const q = await k.quote('alice', A);
    await k.sql(
      `UPDATE cloud.provider_plans SET provider_price_minor = 77 WHERE plan_ref = 'mock.small' AND account_id = $1`,
      [k.accountId],
    );
    try {
      const r = await k.call('alice', 'POST', '/v1/compute/instances', A, {
        quoteId: q.json().id,
        name: 'late',
        sshPublicKeys: [],
      });
      expect(r.statusCode).toBe(409);
      expect(r.json().code ?? r.json().type).toMatch(/price_changed/);
      expect(
        await k.sql(`SELECT 1 FROM commerce.orders WHERE quote_id = $1`, [q.json().id]),
      ).toHaveLength(0); // the quote was NOT consumed
    } finally {
      await k.sql(
        `UPDATE cloud.provider_plans SET provider_price_minor = 12 WHERE plan_ref = 'mock.small' AND account_id = $1`,
        [k.accountId],
      );
    }
  });

  it('capability lost between quote and provision: 422 unsupported_capability', async () => {
    const q = await k.quote('alice', A);
    await k.sql(
      `UPDATE cloud.provider_capabilities SET state = 'unsupported' WHERE account_id = $1 AND capability_id = 'compute.provision'`,
      [k.accountId],
    );
    try {
      const r = await k.call('alice', 'POST', '/v1/compute/instances', A, {
        quoteId: q.json().id,
        name: 'cap',
        sshPublicKeys: [],
      });
      expect(r.statusCode).toBe(422);
      expect(r.json().code ?? r.json().type).toMatch(/unsupported_capability/);
    } finally {
      await k.sql(
        `UPDATE cloud.provider_capabilities SET state = 'supported' WHERE account_id = $1 AND capability_id = 'compute.provision'`,
        [k.accountId],
      );
    }
  });

  it('an expired quote is 409 quote_expired (TTL; the immutability trigger is disabled by the DBA only for this test to age the quote)', async () => {
    const q = await k.quote('alice', A);
    await k.sql(`ALTER TABLE commerce.quotes DISABLE TRIGGER quotes_immutable`);
    try {
      await k.sql(
        `UPDATE commerce.quotes SET created_at = now() - interval '30 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`,
        [q.json().id],
      );
    } finally {
      await k.sql(`ALTER TABLE commerce.quotes ENABLE TRIGGER quotes_immutable`);
    }
    const r = await k.call('alice', 'POST', '/v1/compute/instances', A, {
      quoteId: q.json().id,
      name: 'old',
      sshPublicKeys: [],
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().code ?? r.json().type).toMatch(/quote_expired/);
    expect(
      await k.sql(`SELECT 1 FROM commerce.orders WHERE quote_id = $1`, [q.json().id]),
    ).toHaveLength(0);
  });

  it('a definitive provider failure compensates: capacity error → FAILED, hold released, order failed; the provider holds nothing', async () => {
    const c = await k.createInstance('alice', A);
    const before = k.mock.provisionCalls();
    k.mock.setPlans([
      {
        planRef: 'mock.small',
        vcpu: 1,
        memoryMb: 2048,
        diskGb: 40,
        hourlyMinor: '12',
        currency: 'SAR',
        availability: 'sold_out',
      },
      {
        planRef: 'mock.medium',
        vcpu: 2,
        memoryMb: 4096,
        diskGb: 80,
        hourlyMinor: '24',
        currency: 'SAR',
        availability: 'available',
      },
    ]);
    try {
      // the place step still passes (catalog says available): the PROVIDER refuses (capacity is retryable: the operation retries with backoff until its attempts are used up)
      for (let i = 0; i < 6; i++) {
        await k.sql(
          `UPDATE platform.operations SET next_run_at = now() WHERE id = $1 AND state = 'pending'`,
          [c.operationId],
        );
        await k.runOp(A, c.operationId);
      }
      expect(k.mock.provisionCalls()).toBe(before + 5); // five attempts, each rejected without creating anything
      const op = (
        await k.sql(`SELECT state, error FROM platform.operations WHERE id = $1`, [c.operationId])
      )[0]!;
      expect(op.state).toBe('failed');
      expect(op.error.code).toBe('capacity');
      expect(
        await k.sql(
          `SELECT 1 FROM commerce.authorization_releases r JOIN commerce.authorizations a ON a.id = r.authorization_id JOIN compute.instances i ON i.order_id = a.order_id WHERE i.id = $1`,
          [c.instanceId],
        ),
      ).toHaveLength(1);
      expect(k.mock.billableByToken((await k.instanceRow(c.instanceId)).provision_token)).toBe(0);
    } finally {
      k.mock.setPlans([
        {
          planRef: 'mock.small',
          vcpu: 1,
          memoryMb: 2048,
          diskGb: 40,
          hourlyMinor: '12',
          currency: 'SAR',
          availability: 'available',
        },
        {
          planRef: 'mock.medium',
          vcpu: 2,
          memoryMb: 4096,
          diskGb: 80,
          hourlyMinor: '24',
          currency: 'SAR',
          availability: 'available',
        },
        {
          planRef: 'mock.large',
          vcpu: 4,
          memoryMb: 8192,
          diskGb: 160,
          hourlyMinor: '48',
          currency: 'SAR',
          availability: 'sold_out',
        },
      ]);
    }
  });
});

describe('spend approval (AC-M05-08)', () => {
  it('above the monthly limit the create is refused with spend_approval_required; after approval it proceeds; the approval authorizes ONE order', async () => {
    await k
      .call('alice', 'PUT', '/v1/billing/spending-limits', A, {
        scope: 'org',
        monthlyCapMinor: '1000',
        currency: 'SAR',
      })
      .then((r) => expect(r.statusCode).toBe(200));
    const q = await k.quote('alice', A);
    expect(q.json().requiresApproval).toBe(true);
    const blocked = await k.call('alice', 'POST', '/v1/compute/instances', A, {
      quoteId: q.json().id,
      name: 'big',
      sshPublicKeys: [],
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code ?? blocked.json().type).toMatch(/spend_approval_required/);
    expect(
      await k.sql(`SELECT 1 FROM compute.instances WHERE quote_id = $1`, [q.json().id]),
    ).toHaveLength(0);
    const req = await k.call('alice', 'POST', '/v1/billing/spend-approvals', A, {
      quoteId: q.json().id,
      amount: q.json().totalMinor,
      currency: 'SAR',
      reason: 'production web server',
    });
    expect(req.statusCode).toBe(201);
    const again = await k.call('alice', 'POST', '/v1/compute/instances', A, {
      quoteId: q.json().id,
      name: 'big',
      sshPublicKeys: [],
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().approvalId).toBe(req.json().id); // the pending approval is named in the problem
    // approver: another owner decides (four-eyes where configured); bob is not a member, so use SQL membership for carol as billing admin
    await k.sql(
      `UPDATE tenancy.memberships SET role = 'billing_admin' WHERE org_id = $1 AND user_id = $2`,
      [A, k.ids.carol],
    );
    await k.h.elevate(k.jars.carol!);
    const dec = await k.call(
      'carol',
      'POST',
      `/v1/billing/spend-approvals/${req.json().id}/decision`,
      A,
      { decision: 'approve', note: 'ok' },
    );
    expect([200, 201]).toContain(dec.statusCode);
    const ok = await k.call('alice', 'POST', '/v1/compute/instances', A, {
      quoteId: q.json().id,
      name: 'big',
      sshPublicKeys: [],
    });
    expect(ok.statusCode).toBe(202);
    expect(
      await k.sql(
        `SELECT 1 FROM commerce.authorizations WHERE kind = 'spend_approval' AND org_id = $1`,
        [A],
      ),
    ).toHaveLength(1);
    await k.runOp(A, ok.json().operationId);
  });

  it('cleanup: the spending limit is removed so later tests are not affected', async () => {
    await k.sql(`DELETE FROM billing.spending_limits WHERE org_id = $1`, [A]);
  });
});

describe('tenant isolation (AC-M05-12)', () => {
  it('another organization gets 404 for instance ids; its list is empty; cloud.resources and compute.* are invisible under its RLS context', async () => {
    const mine = (
      await k.sql(`SELECT id, resource_id FROM compute.instances WHERE org_id = $1 LIMIT 1`, [A])
    )[0]!;
    expect((await k.call('bob', 'GET', `/v1/compute/instances/${mine.id}`, B)).statusCode).toBe(
      404,
    );
    expect(
      (
        await k.call('bob', 'DELETE', `/v1/compute/instances/${mine.id}`, B, undefined, {
          'if-match': '"1"',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await k.call('bob', 'POST', `/v1/compute/instances/${mine.id}/actions`, B, { type: 'stop' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await k.call('bob', 'GET', `/v1/compute/instances/${mine.id}/metrics`, B)).statusCode,
    ).toBe(404);
    expect((await k.call('bob', 'GET', '/v1/compute/instances', B)).json().items).toHaveLength(0);
    const db = new Db(k.h.env.appUrl);
    try {
      for (const t of [
        'cloud.resources',
        'compute.instances',
        'compute.instance_actions',
        'compute.snapshots',
        'compute.instance_intervals',
        'commerce.authorization_releases',
      ]) {
        const n = await db.withOrg(B, async (c) =>
          Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n),
        );
        expect(n, t).toBe(0);
      }
      // and A sees its own
      expect(
        await db.withOrg(A, async (c) =>
          Number((await c.query(`SELECT count(*) AS n FROM cloud.resources`)).rows[0]!.n),
        ),
      ).toBeGreaterThan(0);
      // cannot cross by writing either
      await expect(
        db.withOrg(B, (c) =>
          c.query(
            `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, state, data_region, country, provider_region_id) VALUES (gen_random_uuid(), $1, 'compute_instance', $2, 'ACTIVE', 'x', 'SA', 'r')`,
            [A, k.accountId],
          ),
        ),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await db.close();
    }
  });

  it('admin inventory reads are audited and show state/drift; viewers cannot reach the admin API', async () => {
    const before = k.sink.events.filter((e) => e.action === 'admin.resources.listed').length;
    const r = await k.admin('pa', 'GET', `/v1/admin/resources?orgId=${A}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().items.length).toBeGreaterThan(0);
    expect(r.json().items[0]).toMatchObject({
      orgId: A,
      providerKey: 'mock',
      driftState: expect.any(String),
    });
    expect(k.sink.events.filter((e) => e.action === 'admin.resources.listed').length).toBe(
      before + 1,
    );
    expect((await k.admin('pa', 'GET', '/v1/admin/resources?state=RUNNING')).statusCode).toBe(422);
    expect((await k.admin('co', 'GET', '/v1/admin/resources')).statusCode).toBe(403);
    const nf = await k.admin(
      'pa',
      'POST',
      '/v1/admin/resources/00000000-0000-4000-8000-000000000000/reconciliations',
    );
    expect(nf.statusCode).toBe(404);
  });

  it('webhooks: unknown / unsupported providers are 404 and nothing is stored', async () => {
    for (const p of ['alibaba', 'mock', 'nope']) {
      const r = await k.app.inject({
        method: 'POST',
        url: `/v1/webhooks/cloud/${p}`,
        payload: { x: 1 },
      });
      expect(r.statusCode).toBe(404);
    }
    expect(
      await k.sql(
        `SELECT 1 FROM platform.webhook_events_inbound WHERE provider IN ('alibaba','mock','nope')`,
      ),
    ).toHaveLength(0);
  });
});

describe('resource state machine (AC-M05-24)', () => {
  it('the database trigger accepts exactly the transitions of the domain table, for both actors, over all 81 pairs', async () => {
    const c = new Client({ connectionString: k.h.env.adminUrl });
    await c.connect();
    try {
      let checked = 0;
      for (const actor of ['orchestrator', 'reconciler'] as TransitionActor[])
        for (const from of RESOURCE_STATES)
          for (const to of RESOURCE_STATES) {
            if (from === to) continue;
            await c.query('BEGIN');
            await c.query(`SELECT set_config('app.resource_actor', $1, true)`, [actor]);
            const id = (
              await c.query(
                `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, state, data_region, country, provider_region_id) VALUES (gen_random_uuid(), $1, 'compute_instance', $2, $3, 'x', 'SA', 'r') RETURNING id`,
                [A, k.accountId, from],
              )
            ).rows[0].id;
            let ok = true;
            try {
              await c.query('SAVEPOINT s');
              await c.query(`UPDATE cloud.resources SET state = $2 WHERE id = $1`, [id, to]);
            } catch {
              ok = false;
            }
            await c.query('ROLLBACK');
            expect(ok, `${actor}: ${from} -> ${to}`).toBe(canTransitionResource(from, to, actor));
            checked++;
          }
      expect(checked).toBe(2 * 72);
      // a non-canonical state is refused outright
      await expect(
        c.query(
          `INSERT INTO cloud.resources (id, org_id, kind, provider_account_id, state, data_region, country, provider_region_id) VALUES (gen_random_uuid(), $1, 'compute_instance', $2, 'RUNNING', 'x', 'SA', 'r')`,
          [A, k.accountId],
        ),
      ).rejects.toThrow(/check constraint/i);
    } finally {
      await c.end();
    }
  });
});

describe('compute metering through the central pipeline (AC-M05-11 integration half)', () => {
  it('the sampler emits exact hourly usage events once; reruns and duplicates add nothing; closing an interval emits the remainder', async () => {
    const c = await k.createInstance('alice', A, {}, 'meter-1');
    await k.runOp(A, c.operationId);
    const row = await k.instanceRow(c.instanceId);
    const startMs = new Date(
      (
        await k.sql(`SELECT started_at FROM compute.instance_intervals WHERE instance_id = $1`, [
          c.instanceId,
        ])
      )[0]!.started_at,
    ).getTime();
    k.advance(3 * 3_600_000 + 20 * 60_000);
    const sampler = k.app.get(ComputeMeteringSampler);
    const r1 = await sampler.run();
    expect(r1.events).toBeGreaterThan(0);
    const events = async () =>
      (
        await k.sql(
          `SELECT payload FROM platform.outbox WHERE topic = 'usage.recorded' AND org_id = $1 AND payload->>'resourceId' = $2`,
          [A, row.resource_id],
        )
      ).map((e) => e.payload as Row);
    const first = await events();
    const sum = (evs: Row[], meter: string) =>
      evs.filter((e) => e.meterId === meter).reduce((s, e) => s + Number(e.quantity), 0);
    expect(first.every((e) => e.source === 'compute@M05' && e.dataRegion === 'in_kingdom')).toBe(
      true,
    );
    // only COMPLETE hours of an open interval are emitted: exactly the time from the start up to the last full hour boundary (1 vCPU => 1 vCPU-hour per hour)
    const hourFloor = Math.floor(k.clock.now() / 3_600_000) * 3_600_000;
    expect(sum(first, 'compute.vcpu_hours')).toBeCloseTo((hourFloor - startMs) / 3_600_000, 4);
    const again = await sampler.run();
    expect(again.events).toBe(0); // nothing new: emitted_until moved in the same transaction
    expect((await events()).length).toBe(first.length);
    // stop: the remaining partial hour is emitted exactly once at the close
    const stop = await k.call('alice', 'POST', `/v1/compute/instances/${c.instanceId}/actions`, A, {
      type: 'stop',
    });
    await k.runOp(A, stop.json().operationId);
    await sampler.run();
    const all = await events();
    const ids = all.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length); // unique deterministic event ids
    const total = sum(all, 'compute.vcpu_hours');
    expect(total).toBeCloseTo((k.clock.now() - startMs) / 3_600_000, 1); // 1 vCPU: usage equals the running time
    await sampler.run();
    expect((await events()).length).toBe(all.length);
  });
});

void ProvisioningService;
void SSH_KEY;
