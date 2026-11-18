import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelay, enqueue, eventId } from '@nuzm/platform';
import { ORG_A, ORG_B, createEnv, type TestEnv } from '@nuzm/platform/testing';
import { automationConsumer } from './automation-consumers';

let env: TestEnv;
const WF = '0190a000-0000-7000-8000-0000000000a1';
const VER = '0190a000-0000-7000-8000-0000000000a2';
const EP = '0190a000-0000-7000-8000-0000000000a3';
const sql = (q: string, p: unknown[] = []) => env.sql(q, p);

beforeAll(async () => {
  env = await createEnv();
  await sql(`INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'automation.enabled', NULL, 'true')`);
  await sql(`INSERT INTO automation.workflows (id, org_id, name, status, triggers, data_region, active_version_id) VALUES ($1,$2,'w','draft','[{"type":"platform_event","topic":"invoice.issued"}]','sa-pending',NULL)`, [WF, ORG_A]);
  await sql(`INSERT INTO automation.workflow_versions (id, org_id, workflow_id, version, definition, definition_hash) VALUES ($1,$2,$3,1,'{}',$4)`, [VER, ORG_A, WF, 'a'.repeat(64)]);
  await sql(`UPDATE automation.workflows SET active_version_id = $2, status = 'active' WHERE id = $1`, [WF, VER]);
  await sql(`INSERT INTO automation.webhook_endpoints (id, org_id, url, events, secret_vault_ref, data_region) VALUES ($1,$2,'https://hooks.example.com/x','{invoice.issued}','vault://mem/tenant-x','sa-pending')`, [EP, ORG_A]);
}, 120_000);
afterAll(() => env.close());

describe('automation outbox consumer (worker role, org taken from the outbox row)', () => {
  it('one execution and one webhook delivery per event, however often the event is redelivered', async () => {
    const consume = automationConsumer(env.worker);
    await env.app.withOrg(ORG_A, (c) => enqueue(c, ORG_A, 'invoice.issued', { invoiceId: 'i-1' }));
    const relay = new OutboxRelay(env.worker, { batch: 50, lockSeconds: 1 });
    const seen: { executions: number; deliveries: number }[] = [];
    const handler = async (row: Parameters<Parameters<OutboxRelay['runOnce']>[0]>[0]) => {
      if (row.topic === 'invoice.issued') seen.push(await consume(row.topic, row.payload, { eventId: eventId(row), orgId: row.org_id }));
    };
    await relay.runOnce(handler);
    expect(seen).toEqual([{ executions: 1, deliveries: 1 }]);
    // simulated redelivery: the consumer runs again for the SAME event id
    const row = (await sql(`SELECT id, org_id, topic, payload FROM platform.outbox WHERE topic = 'invoice.issued' LIMIT 1`))[0]!;
    const again = await consume('invoice.issued', row.payload, { eventId: eventId({ id: row.id as string }), orgId: row.org_id as string });
    expect(again).toEqual({ executions: 0, deliveries: 0 });
    expect(Number((await sql(`SELECT count(*) n FROM automation.executions WHERE workflow_id = $1`, [WF]))[0]!.n)).toBe(1);
    expect(Number((await sql(`SELECT count(*) n FROM automation.webhook_deliveries WHERE endpoint_id = $1`, [EP]))[0]!.n)).toBe(1);
    const ex = (await sql(`SELECT trigger, chain_depth, input FROM automation.executions WHERE workflow_id = $1`, [WF]))[0]!;
    expect(ex.trigger).toBe('platform_event');
    expect(ex.chain_depth).toBe(1);
  });
  it('another organization, other topics and non-allow-listed topics start nothing', async () => {
    const consume = automationConsumer(env.worker);
    expect(await consume('invoice.issued', {}, { eventId: 'evt-b', orgId: ORG_B })).toEqual({ executions: 0, deliveries: 0 });
    expect(await consume('site.deployed', {}, { eventId: 'evt-c', orgId: ORG_A })).toEqual({ executions: 0, deliveries: 0 });
    expect(await consume('secrets.leaked', {}, { eventId: 'evt-d', orgId: ORG_A })).toEqual({ executions: 0, deliveries: 0 });
    expect(Number((await sql(`SELECT count(*) n FROM automation.executions`))[0]!.n)).toBe(1);
  });
  it('a disabled feature flag, a paused workflow and a too-deep chain skip the workflow without failing the event', async () => {
    const consume = automationConsumer(env.worker, () => undefined);
    await sql(`UPDATE platform.feature_flags SET value = 'false' WHERE key = 'automation.enabled'`);
    expect((await consume('invoice.issued', {}, { eventId: 'evt-e', orgId: ORG_A })).executions).toBe(0);
    await sql(`UPDATE platform.feature_flags SET value = 'true' WHERE key = 'automation.enabled'`);
    expect((await consume('invoice.issued', { automationDepth: 5 }, { eventId: 'evt-f', orgId: ORG_A })).executions).toBe(0);
    await sql(`UPDATE automation.workflows SET status = 'paused' WHERE id = $1`, [WF]);
    expect((await consume('invoice.issued', {}, { eventId: 'evt-g', orgId: ORG_A })).executions).toBe(0);
    expect(Number((await sql(`SELECT count(*) n FROM automation.executions`))[0]!.n)).toBe(1);
  });
  it('the worker role cannot read another organization through the consumer (RLS)', async () => {
    const rows = await env.worker.withOrg(ORG_B, async (c) => (await c.query(`SELECT count(*)::int n FROM automation.workflows`)).rows[0]!.n);
    expect(rows).toBe(0);
  });
});
