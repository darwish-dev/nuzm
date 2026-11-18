import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAutomationEnv, type AutoEnv } from '../automation/testing/automation-harness';

/** The REAL hash-chained audit sink: a delegated request records the agency as the actor organization and the client as the organization acted in. */
let e: AutoEnv;
const sql = (q: string, p: unknown[] = []) => e.h.env.sql(q, p);
const SIMPLE = {
  schemaVersion: 1,
  start: 'calc',
  steps: [{ id: 'calc', type: 'transform', params: { output: { ok: true } } }],
};

beforeAll(async () => {
  e = await setupAutomationEnv([], true, true);
  await e.setFlag('agency.enabled', true);
}, 240_000);
afterAll(() => e.h.close());

describe('delegation audit (real audit chain)', () => {
  it('records actor user, actor organization (agency) and acting-in organization (client) on the mutation and on the access event', async () => {
    const cookie = (who: string) =>
      Object.entries(e.jars[who]!)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
    const mk = async (who: string, name: string, type: string) =>
      (
        await e.app.inject({
          method: 'POST',
          url: '/v1/organizations',
          headers: { cookie: cookie(who), 'x-csrf-token': e.jars[who]!.nuzm_csrf! },
          payload: { name, type },
        })
      ).json().id as string;
    const G = await mk('erin', 'Audit agency', 'agency');
    await sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'developer')`,
      [G, e.ids.dave],
    );
    const A = e.org.A!;
    const agency = (
      await e.call('erin', 'POST', '/v1/agencies', { name: 'Audit agency' }, G)
    ).json();
    const link = (
      await e.call('erin', 'POST', `/v1/agencies/${agency.id}/clients`, { clientOrgId: A }, G)
    ).json();
    expect(
      (
        await e.call(
          'alice',
          'POST',
          `/v1/agencies/${agency.id}/clients`,
          { linkId: link.id, decision: 'accept' },
          A,
        )
      ).statusCode,
    ).toBe(201);
    const grant = (
      await e.call(
        'erin',
        'POST',
        `/v1/agencies/${agency.id}/delegated-access`,
        {
          clientOrgId: A,
          scopes: ['automation:read', 'automation:write'],
          expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        },
        G,
      )
    ).json();
    expect(
      (
        await e.call(
          'alice',
          'POST',
          `/v1/agencies/${agency.id}/delegated-access`,
          { grantId: grant.id, decision: 'accept' },
          A,
        )
      ).statusCode,
    ).toBe(201);

    const r = await e.call(
      'dave',
      'POST',
      '/v1/workflows',
      { name: 'by the agency', definition: SIMPLE },
      G,
      { 'x-nuzm-acting-org': A },
    );
    expect(r.statusCode, r.body).toBe(201);
    const mutation = await sql(
      `SELECT org_id, acting_org_id, actor_user_id, actor_type FROM audit.audit_logs WHERE action = 'workflow.version.created' AND resource_id = $1`,
      [r.json().id],
    );
    const all = await sql(
      `SELECT action, resource_type, resource_id::text rid, org_id::text oid, acting_org_id::text aid FROM audit.audit_logs ORDER BY occurred_at DESC LIMIT 12`,
    );
    expect(mutation, JSON.stringify({ wf: r.json().id, all })).toHaveLength(1);
    expect(mutation[0]).toMatchObject({
      org_id: A,
      acting_org_id: G,
      actor_user_id: e.ids.dave,
      actor_type: 'user',
    });
    const used = await sql(
      `SELECT org_id, acting_org_id, actor_user_id FROM audit.audit_logs WHERE action = 'delegation.access.used' AND resource_id = $1 ORDER BY occurred_at DESC LIMIT 1`,
      [grant.id],
    );
    expect(used[0]).toMatchObject({ org_id: A, acting_org_id: G, actor_user_id: e.ids.dave });
    // the client reads these events in its own audit log; an unrelated organization does not
    const own = await e.call('alice', 'GET', '/v1/audit-logs?limit=50', undefined, A);
    expect(own.statusCode).toBe(200);
    expect(JSON.stringify(own.json())).toContain('delegation.access.used');
    expect(
      JSON.stringify(
        (await e.call('bob', 'GET', '/v1/audit-logs?limit=50', undefined, e.org.B)).json(),
      ),
    ).not.toContain('delegation.access.used');
    // the client's own mutations carry no acting organization
    const own2 = await e.call(
      'alice',
      'POST',
      '/v1/workflows',
      { name: 'by the client', definition: SIMPLE },
      A,
    );
    const clean = await sql(
      `SELECT acting_org_id FROM audit.audit_logs WHERE action = 'workflow.version.created' AND resource_id = $1`,
      [own2.json().id],
    );
    expect(clean[0]!.acting_org_id).toBeNull();
  });
});
