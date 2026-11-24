import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { mockModelHandler } from '@nuzm/domain';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { DeployService, InMemorySitePublisher, SitePublisherPort } from './index';

/**
 * Session 06: SIMULATED labelling, status synchronization, cancellation, recovery and authorization of website deployments. Everything runs against the in-memory
 * publisher (a stand-in, NOT a hosting node): a passing run is evidence about the pipeline, never about a real node (HG-05/HG-06).
 */
let e: AiEnv;
let deploys: DeployService;
let pub: InMemorySitePublisher;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
let planId: string;
const mkSite = async (org: string, user: string, name: string, domain: string | null = null) => {
  const id = randomUUID();
  await e.sql(
    `INSERT INTO hosting.sites (id, org_id, name, token, node_name, plan_id, runtime, status, data_region, created_by, credentials_ref, backup_key_ref, domain_primary)
     VALUES ($1,$2,$3,$4,$5,$6,'static','active','sa-central',$7,'vault://t/c','vault://t/b',$8)`,
    [
      id,
      org,
      name,
      randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      `s-${randomUUID().replace(/-/g, '').slice(0, 14)}`,
      planId,
      e.ids[user],
      domain,
    ],
  );
  return id;
};
const mkProject = async (name: string, who = 'alice', org = A()) =>
  j(
    await e.call(
      who,
      'POST',
      '/v1/builder/projects',
      { type: 'website', name, locale: ['ar', 'en'], templateId: 'landing' },
      org,
    ),
  );
const req = (body: Row, who = 'alice', org = A()) =>
  e.call(who, 'POST', '/v1/deployments', body, org, { 'idempotency-key': `k-${Math.random()}` });
/** the two-step human confirmation: ask, then confirm with the approval id */
const publish = async (projectId: string, siteId: string, who = 'alice') => {
  const first = await req({ projectId, target: siteId, environment: 'production' }, who);
  expect(first.statusCode, first.body).toBe(403);
  return req(
    { projectId, target: siteId, environment: 'production', approvalId: first.json().approvalId },
    who,
  );
};
const opOf = async (id: string) =>
  (await e.sql(`SELECT operation_id FROM deploy.deployments WHERE id=$1`, [id]))[0]!
    .operation_id as string;
const drive = async (id: string, org = A()) => {
  await deploys.runOne(org, await opOf(id));
  return j(await e.call('alice', 'GET', `/v1/deployments/${id}`, undefined, org));
};
const get = async (id: string) => j(await e.call('alice', 'GET', `/v1/deployments/${id}`));
const cancel = (id: string, who = 'alice', org = A()) =>
  e.call(who, 'POST', `/v1/deployments/${id}/cancel`, undefined, org);
const audits = (action: string) => e.sink.events.filter((x) => x.action === action);

beforeAll(async () => {
  e = await setupAiEnv();
  deploys = e.app.get(DeployService);
  pub = e.app.get(SitePublisherPort) as InMemorySitePublisher;
  await e.enableMock('mock-model', {
    adapter: new MockModelAdapter({ id: 'mock-model', handler: (r) => mockModelHandler(r) }),
  });
  planId = randomUUID();
  await e.sql(
    `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation) VALUES ($1, 's06-plan', 'خطة', 'Plan', 'active', '{"diskMb":1,"inodes":1000,"bandwidthGb":1,"dbCount":1,"sitesCount":1}', '["php"]', '{"cpu_millicores":1,"memory_mb":1,"disk_mb":1}')`,
    [planId],
  );
}, 120_000);
afterAll(() => e.h.close());

describe('SIMULATED labelling and status synchronization', () => {
  it('every deployment says simulated: true; the state moves queued -> succeeded and the list, the read and the logs agree', async () => {
    const p = await mkProject('S06 Status');
    const site = await mkSite(A(), 'alice', 's06-status', 'status.example.sa');
    const created = j(await publish(p.id as string, site));
    expect(created.state).toBe('queued');
    expect(created.simulated).toBe(true);
    // a second reader sees the same state (status sync across callers)
    expect(j(await e.call('carol', 'GET', `/v1/deployments/${created.id}`)).state).toBe('queued');
    const done = await drive(created.id as string);
    expect(done).toMatchObject({ state: 'succeeded', simulated: true });
    expect(j(await e.call('carol', 'GET', `/v1/deployments/${created.id}`)).state).toBe(
      'succeeded',
    );
    const list = j(await e.call('alice', 'GET', `/v1/deployments?projectId=${p.id}`))
      .items as Row[];
    expect(list.find((d) => d.id === created.id)).toMatchObject({
      state: 'succeeded',
      simulated: true,
    });
    // logs: strictly increasing seq, and `?after=` resumes without repeating
    const logs = j(await e.call('alice', 'GET', `/v1/deployments/${created.id}/logs`))
      .items as Row[];
    const seqs = logs.map((l) => Number(l.seq));
    expect(seqs.length).toBeGreaterThan(3);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const rest = j(
      await e.call('alice', 'GET', `/v1/deployments/${created.id}/logs?after=${seqs[1]}`),
    ).items as Row[];
    expect(rest.map((l) => Number(l.seq))).toEqual(seqs.slice(2));
    expect(logs.map((l) => String(l.message)).join('\n')).toContain('deployment succeeded');
  });
});

describe('cancellation', () => {
  it('a queued deployment is cancelled at once: terminal state, operation cancelled, the live site untouched, the target free again, audited', async () => {
    const p = await mkProject('S06 Cancel Queued');
    const site = await mkSite(A(), 'alice', 's06-cancel-queued');
    const first = j(await publish(p.id as string, site));
    await drive(first.id as string); // something is live
    const liveBefore = pub.live.get(site)!.hash;
    const second = j(await publish(p.id as string, site));
    expect(second.state).toBe('queued');
    const r = await cancel(second.id as string);
    expect(r.statusCode, r.body).toBe(202);
    expect(j(r)).toMatchObject({ state: 'cancelled', error: { code: 'cancelled' } });
    expect(j(r).finishedAt).toBeTruthy();
    const op = (
      await e.sql(`SELECT state FROM platform.operations WHERE id=$1`, [
        await opOf(second.id as string),
      ])
    )[0]!;
    expect(op.state).toBe('cancelled');
    // a worker that still holds the id cannot run it
    expect(await deploys.runOne(A(), await opOf(second.id as string))).toBe(false);
    expect(pub.live.get(site)!.hash).toBe(liveBefore);
    expect(pub.staged.has(second.id as string)).toBe(false);
    expect(
      audits('deploy.deployment.cancelled').some(
        (x) => (x.resource as Row).id === second.id && x.outcome === 'success',
      ),
    ).toBe(true);
    // the one-in-flight slot is free: a new deployment to the same target is accepted
    expect((await publish(p.id as string, site)).statusCode).toBe(202);
  });

  it('a running deployment is flagged and stops at its next checkpoint: the staged upload is discarded, the live artifact stays, state cancelled', async () => {
    const p = await mkProject('S06 Cancel Running');
    const site = await mkSite(A(), 'alice', 's06-cancel-running');
    await drive(j(await publish(p.id as string, site)).id as string);
    const liveBefore = pub.live.get(site)!.hash;
    const dep = j(await publish(p.id as string, site));
    const stage = pub.stage.bind(pub);
    let cancelStatus = 0;
    pub.stage = async (s, a, id) => {
      const out = await stage(s, a, id);
      cancelStatus = (await cancel(id)).statusCode; // the user cancels while the artifact is being staged
      return out;
    };
    let done: Row;
    try {
      done = await drive(dep.id as string);
    } finally {
      pub.stage = stage;
    }
    expect(cancelStatus).toBe(202);
    expect(done.state).toBe('cancelled');
    expect(done.error).toMatchObject({ code: 'cancelled', at: 'before_switch' });
    expect(pub.staged.has(dep.id as string)).toBe(false);
    expect(pub.live.get(site)!.hash).toBe(liveBefore);
    const logs = (
      j(await e.call('alice', 'GET', `/v1/deployments/${dep.id}/logs`)).items as Row[]
    ).map((l) => String(l.message));
    expect(logs.some((m) => m.includes('cancellation requested'))).toBe(true);
    expect(logs.some((m) => m.includes('the live site was not touched'))).toBe(true);
    // the audit trail has the request (user) and the stop (system)
    const mine = audits('deploy.deployment.cancelled').filter(
      (x) => (x.resource as Row).id === dep.id,
    );
    expect(mine.map((x) => x.actorType).sort()).toEqual(['system', 'user']);
  });

  it('after the switch it is too late: the deployment ends succeeded (use rollback); a finished deployment answers 409', async () => {
    const p = await mkProject('S06 Cancel Late');
    const site = await mkSite(A(), 'alice', 's06-cancel-late');
    const dep = j(await publish(p.id as string, site));
    const smoke = pub.smoke.bind(pub);
    let status = 0;
    pub.smoke = async (s, where, ref, paths) => {
      if (where === 'live' && !status) status = (await cancel(dep.id as string)).statusCode;
      return smoke(s, where, ref, paths);
    };
    let done: Row;
    try {
      done = await drive(dep.id as string);
    } finally {
      pub.smoke = smoke;
    }
    expect(status).toBe(202); // accepted as a request, but the switch had already happened
    expect(done.state).toBe('succeeded');
    expect(pub.live.get(site)!.hash).toBe(done.artifactHash);
    const again = await cancel(dep.id as string);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('invalid_state');
  });

  it('is refused for a viewer (403), without a session (401), for another organization (404) and for an unknown id (404)', async () => {
    const p = await mkProject('S06 Cancel Authz');
    const site = await mkSite(A(), 'alice', 's06-cancel-authz');
    const dep = j(await publish(p.id as string, site));
    expect((await cancel(dep.id as string, 'carol')).statusCode).toBe(403);
    expect(
      (await e.app.inject({ method: 'POST', url: `/v1/deployments/${dep.id}/cancel` })).statusCode,
    ).toBe(401);
    expect((await cancel(dep.id as string, 'bob', B())).statusCode).toBe(404);
    expect((await cancel(randomUUID())).statusCode).toBe(404);
    expect((await cancel('not-a-uuid')).statusCode).toBe(404);
    expect((await get(dep.id as string)).state).toBe('queued'); // none of the refusals touched it
    await cancel(dep.id as string); // clean up the in-flight slot
  });
});

describe('failure recovery (scheduler tick)', () => {
  it('an orphaned deployment whose operation was cancelled and has no worker is closed `cancelled`; nothing is switched', async () => {
    const p = await mkProject('S06 Orphan Cancel');
    const site = await mkSite(A(), 'alice', 's06-orphan-cancel');
    const dep = j(await publish(p.id as string, site));
    await e.sql(
      `UPDATE platform.operations SET state='cancelled', cancel_requested=true WHERE id=$1`,
      [await opOf(dep.id as string)],
    );
    expect((await get(dep.id as string)).state).toBe('queued'); // the crash left it open
    await deploys.tick();
    expect(await get(dep.id as string)).toMatchObject({
      state: 'cancelled',
      error: { code: 'cancelled', recovered: true },
    });
    expect(pub.live.has(site)).toBe(false);
  });

  it('an operation that ended failed while the deployment never finished closes it `failed` (operation_lost)', async () => {
    const p = await mkProject('S06 Orphan Lost');
    const site = await mkSite(A(), 'alice', 's06-orphan-lost');
    const dep = j(await publish(p.id as string, site));
    await e.sql(`UPDATE platform.operations SET state='failed' WHERE id=$1`, [
      await opOf(dep.id as string),
    ]);
    await deploys.tick();
    expect(await get(dep.id as string)).toMatchObject({
      state: 'failed',
      error: { code: 'operation_lost' },
    });
    expect(pub.live.has(site)).toBe(false);
  });

  it('a worker that died mid-run (expired lease) is re-claimed by the tick and the deployment completes (reconcile before retry)', async () => {
    const p = await mkProject('S06 Dead Worker');
    const site = await mkSite(A(), 'alice', 's06-dead-worker');
    const dep = j(await publish(p.id as string, site));
    // the first worker claimed it and died: running, lease in the past
    await e.sql(
      `UPDATE platform.operations SET state='running', attempts=1, lease_owner='dead-worker', lease_expires_at=now() - interval '5 minutes' WHERE id=$1`,
      [await opOf(dep.id as string)],
    );
    await deploys.tick();
    expect((await get(dep.id as string)).state).toBe('succeeded');
    expect(pub.live.get(site)!.hash).toBeTruthy();
  });
});

describe('authorization and tenant isolation of the deployment routes', () => {
  it('no route answers without a session (401); a viewer reads but cannot publish, cancel or roll back; org B sees nothing of org A', async () => {
    const p = await mkProject('S06 Authz');
    const site = await mkSite(A(), 'alice', 's06-authz', 'authz.example.sa');
    const dep = j(await publish(p.id as string, site));
    const done = await drive(dep.id as string);
    expect(done.state).toBe('succeeded');
    for (const [m, u] of [
      ['GET', '/v1/deployments'],
      ['GET', `/v1/deployments/${dep.id}`],
      ['GET', `/v1/deployments/${dep.id}/logs`],
      ['POST', '/v1/deployments'],
      ['POST', `/v1/deployments/${dep.id}/rollback`],
      ['POST', `/v1/deployments/${dep.id}/cancel`],
    ] as const)
      expect((await e.app.inject({ method: m, url: u })).statusCode, `${m} ${u}`).toBe(401);
    expect((await e.call('carol', 'GET', `/v1/deployments/${dep.id}`)).statusCode).toBe(200);
    expect(
      (await req({ projectId: p.id, target: site, environment: 'staging' }, 'carol')).statusCode,
    ).toBe(403);
    expect((await e.call('carol', 'POST', `/v1/deployments/${dep.id}/rollback`)).statusCode).toBe(
      403,
    );
    const other = await Promise.all([
      e.call('bob', 'GET', `/v1/deployments/${dep.id}`, undefined, B()),
      e.call('bob', 'GET', `/v1/deployments/${dep.id}/logs`, undefined, B()),
      e.call('bob', 'POST', `/v1/deployments/${dep.id}/rollback`, undefined, B()),
      cancel(dep.id as string, 'bob', B()),
    ]);
    expect(other.map((r) => r.statusCode)).toEqual([404, 404, 404, 404]);
  });

  it('DEFECT-4: an API key may ask for a publish approval but can never confirm it; a person confirms it and the audit says so', async () => {
    const p = await mkProject('S06 Api Key');
    const site = await mkSite(A(), 'alice', 's06-api-key');
    const k = await e.call('alice', 'POST', '/v1/api-keys', {
      name: 'deploy-bot',
      scopes: ['deploy:write'],
    });
    expect(k.statusCode, k.body).toBe(201);
    const bearer = j(k).key as string;
    const asKey = (body: Row) =>
      e.app.inject({
        method: 'POST',
        url: '/v1/deployments',
        headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `k-${Math.random()}` },
        payload: body,
      });
    const body = { projectId: p.id, target: site, environment: 'production' };
    const ask = await asKey(body);
    expect(ask.statusCode, ask.body).toBe(403);
    expect(ask.json().code).toBe('approval_required');
    const before = Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n);
    const confirm = await asKey({ ...body, approvalId: ask.json().approvalId });
    expect(confirm.statusCode, confirm.body).toBe(403);
    expect(confirm.json().code).toBe('forbidden');
    expect(Number((await e.sql(`SELECT count(*) n FROM deploy.deployments`))[0]!.n)).toBe(before);
    expect(
      (await e.sql(`SELECT state FROM ai.approvals WHERE id=$1`, [ask.json().approvalId]))[0]!
        .state,
    ).toBe('pending'); // nothing was decided
    // a signed-in person confirms the very same approval
    const ok = await req({ ...body, approvalId: ask.json().approvalId });
    expect(ok.statusCode, ok.body).toBe(202);
    expect(
      (
        await e.sql(`SELECT state, decided_by FROM ai.approvals WHERE id=$1`, [
          ask.json().approvalId,
        ])
      )[0],
    ).toMatchObject({ state: 'approved', decided_by: e.ids.alice });
  });
});
