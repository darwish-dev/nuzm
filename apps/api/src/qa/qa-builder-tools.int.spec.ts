import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectsPort } from '../modules/appbuilder';
import { setupAiEnv, type AiEnv, type Row } from '../modules/ai/testing/ai-harness';

/**
 * Session 07 (QA) - the builder-tools routes of Session 05 at the HTTP level (own Postgres, in-process server, dev-reference model, nothing leaves the process; the Git
 * store and model are the harness ones). Flag `builder_tools.enabled`, default OFF. Covered: flag-off 404; authentication and role matrix (viewer reads but cannot write,
 * billing admin can do nothing, developer can write); cross-tenant (session and API key of organization B against organization A's project ids -> 404 with no leak);
 * the two dry-run routes (`plan-previews`, `change-previews`) write NOTHING (the Master's rationale for not requiring an Idempotency-Key, proven by row counts);
 * idempotency of the write routes; malformed input is 4xx, never 5xx. Offline: says nothing about a real model.
 */
let e: AiEnv;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
let ports: ProjectsPort;
let pid = '';
let v1 = '';
let v2 = '';
let bpid = '';

const FILES1 = new Map([
  ['README.md', '# qa app\n'],
  ['src/answer.ts', 'export const answer = 1;\n'],
  ['package.json', JSON.stringify({ name: 'qa-app', version: '1.0.0' })],
]);
const FILES2 = new Map(FILES1).set('src/answer.ts', 'export const answer = 2;\n');

const setFlag = (org: string | null, on: boolean) =>
  e.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'builder_tools.enabled', $1, $2::jsonb)`,
    [org, JSON.stringify(on)],
  );
const clearFlag = () =>
  e.sql(`DELETE FROM platform.feature_flags WHERE key = 'builder_tools.enabled'`);

/** every builder-tools route as [method, path factory, needs write?] */
const ROUTES: {
  m: 'GET' | 'POST' | 'DELETE';
  url: (p: string) => string;
  write: boolean;
  body?: () => Row;
}[] = [
  {
    m: 'POST',
    url: () => '/v1/builder/plan-previews',
    write: false,
    body: () => ({ text: 'A booking site for a barber shop with a contact form' }),
  },
  {
    m: 'POST',
    url: (p) => `/v1/builder/projects/${p}/change-previews`,
    write: false,
    body: () => ({ patches: [{ op: 'add', path: 'src/new.ts', content: 'export {};\n' }] }),
  },
  {
    m: 'GET',
    url: (p) => `/v1/builder/projects/${p}/version-diff?from=${v1}&to=${v2}`,
    write: false,
  },
  { m: 'GET', url: (p) => `/v1/builder/projects/${p}/review`, write: false },
  { m: 'GET', url: (p) => `/v1/builder/projects/${p}/symbols?q=answer`, write: false },
  { m: 'GET', url: (p) => `/v1/builder/projects/${p}/import-analysis`, write: false },
  { m: 'GET', url: (p) => `/v1/builder/projects/${p}/components`, write: false },
  { m: 'GET', url: (p) => `/v1/builder/projects/${p}/memory`, write: false },
  {
    m: 'POST',
    url: (p) => `/v1/builder/projects/${p}/rollbacks`,
    write: true,
    body: () => ({ targetVersion: v1 }),
  },
  {
    m: 'POST',
    url: (p) => `/v1/builder/projects/${p}/reverts`,
    write: true,
    body: () => ({ versionId: v2 }),
  },
  {
    m: 'POST',
    url: (p) => `/v1/builder/projects/${p}/memory`,
    write: true,
    body: () => ({ kind: 'decision', text: 'qa note' }),
  },
  { m: 'DELETE', url: (p) => `/v1/builder/projects/${p}/memory/${randomUUID()}`, write: true },
];
const call = (who: string, r: (typeof ROUTES)[number], project: string, org = A()) =>
  e.call(who, r.m, r.url(project), r.body ? r.body() : undefined, org);
const withKey = (bearer: string, r: (typeof ROUTES)[number], project: string) =>
  e.app.inject({
    method: r.m,
    url: r.url(project),
    headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': `k-${Math.random()}` },
    ...(r.body ? { payload: r.body() } : {}),
  });
const mkKey = async (who: string, scopes: string[], org: string) => {
  const r = await e.call(who, 'POST', '/v1/api-keys', { name: `qa-${Math.random()}`, scopes }, org);
  expect(r.statusCode, r.body).toBe(201);
  return j(r).key as string;
};
const count = async (sql: string) => Number((await e.sql(sql))[0]!.n);

beforeAll(async () => {
  e = await setupAiEnv();
  ports = e.app.get(ProjectsPort);
  const mk = async (org: string, who: string) => {
    const p = await ports.create(org, {
      type: 'webapp',
      name: 'QA tools',
      dataRegion: 'sa-central',
      createdBy: e.ids[who]!,
    });
    const a = await ports.commit(org, p.id, {
      baseVersionId: null,
      files: FILES1,
      source: 'ai',
      createdBy: e.ids[who]!,
    });
    const b = await ports.commit(org, p.id, {
      baseVersionId: a.id,
      files: FILES2,
      source: 'ai',
      createdBy: e.ids[who]!,
    });
    return { id: p.id, v1: a.id, v2: b.id };
  };
  const a = await mk(A(), 'alice');
  pid = a.id;
  v1 = a.v1;
  v2 = a.v2;
  bpid = (await mk(B(), 'bob')).id;
}, 180_000);
afterAll(() => e.h.close());

describe('QA builder tools: flag OFF (the default) hides every route', () => {
  it('every route answers 404 for the owner of an organization with the flag off', async () => {
    await clearFlag();
    const bad: string[] = [];
    for (const r of ROUTES) {
      const res = await call('alice', r, pid);
      if (res.statusCode !== 404) bad.push(`${r.m} ${r.url(pid)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });
  it('an explicit organization "false" beats a global "true" (organization row wins) and an organization "true" beats a global "false"', async () => {
    await clearFlag();
    await setFlag(null, true);
    await setFlag(A(), false);
    expect((await call('alice', ROUTES[0]!, pid)).statusCode).toBe(404);
    expect((await call('bob', ROUTES[0]!, bpid, B())).statusCode).toBe(200); // B follows the global row
    await clearFlag();
    await setFlag(null, false);
    await setFlag(A(), true);
    expect((await call('alice', ROUTES[0]!, pid)).statusCode).toBe(200);
    expect((await call('bob', ROUTES[0]!, bpid, B())).statusCode).toBe(404);
    await clearFlag();
  });
});

describe('QA builder tools: flag ON, authentication and roles', () => {
  beforeAll(async () => {
    await clearFlag();
    await setFlag(A(), true);
    await setFlag(B(), true);
  });

  it('no session -> 401 on every route', async () => {
    const bad: string[] = [];
    for (const r of ROUTES) {
      const res = await e.app.inject({
        method: r.m,
        url: r.url(pid),
        headers: { 'x-nuzm-org': A(), 'idempotency-key': 'k' },
        ...(r.body ? { payload: r.body() } : {}),
      });
      if (res.statusCode !== 401) bad.push(`${r.m} ${r.url(pid)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('a user who is not a member of the organization -> 404 on every route', async () => {
    const bad: string[] = [];
    for (const r of ROUTES) {
      const res = await call('bob', r, pid, A());
      if (res.statusCode !== 404) bad.push(`${r.m} ${r.url(pid)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
  });

  it('a billing admin holds builder:read (migration 1400 gives it to every role) but never builder:write: reads pass authorization, every write is 403', async () => {
    const bad: string[] = [];
    for (const r of ROUTES) {
      const res = await call('frank', r, pid);
      if (r.write && res.statusCode !== 403)
        bad.push(`WRITE ${r.m} ${r.url(pid)} -> ${res.statusCode}`);
      if (!r.write && res.statusCode === 403) bad.push(`READ ${r.m} ${r.url(pid)} -> 403`);
    }
    expect(bad).toEqual([]);
  });

  it('a viewer can read but can NEVER rollback, revert or write/forget memory: 403 and nothing changes', async () => {
    const versions = await count(
      `SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`,
    );
    const audits = e.sink.events.length;
    const bad: string[] = [];
    for (const r of ROUTES) {
      const res = await call('carol', r, pid);
      if (r.write && res.statusCode !== 403)
        bad.push(`WRITE ${r.m} ${r.url(pid)} -> ${res.statusCode}`);
      if (!r.write && res.statusCode === 403)
        bad.push(`READ ${r.m} ${r.url(pid)} -> 403 (a viewer holds builder:read)`);
      if (res.statusCode >= 500) bad.push(`${r.m} ${r.url(pid)} -> ${res.statusCode}`);
    }
    expect(bad).toEqual([]);
    expect(
      await count(`SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`),
    ).toBe(versions);
    expect(e.sink.events.length).toBe(audits);
  });

  it('a developer holds builder:write: no write route answers 403; no route answers 5xx', async () => {
    for (const r of ROUTES) {
      const res = await call('dave', r, pid);
      expect(res.statusCode, `${r.m} ${r.url(pid)}`).not.toBe(403);
      expect(res.statusCode, `${r.m} ${r.url(pid)} ${res.body.slice(0, 100)}`).toBeLessThan(500);
    }
  });

  it('API keys: a read-scoped key cannot reach the write routes (403); a write-scoped key of the SAME organization can pass authorization', async () => {
    const ro = await mkKey('alice', ['builder:read'], A());
    for (const r of ROUTES.filter((x) => x.write))
      expect((await withKey(ro, r, pid)).statusCode, `${r.m} ${r.url(pid)}`).toBe(403);
    for (const r of ROUTES.filter((x) => !x.write))
      expect((await withKey(ro, r, pid)).statusCode, `${r.m} ${r.url(pid)}`).not.toBe(403);
    const rw = await mkKey('alice', ['builder:read', 'builder:write'], A());
    const res = await withKey(
      rw,
      ROUTES.find((x) => x.url('x').endsWith('/memory') && x.m === 'POST')!,
      pid,
    );
    expect([201, 422, 409], res.body.slice(0, 120)).toContain(res.statusCode);
  });
});

describe('QA builder tools: cross-tenant (organization B against organization A project ids)', () => {
  it("session of B (flag on for both) gets 404 on every project route and no trace of A's project", async () => {
    for (const r of ROUTES.filter((x) => x.url('x').includes('/projects/'))) {
      const res = await call('bob', r, pid, B());
      expect(res.statusCode, `${r.m} ${r.url(pid)}`).toBe(404);
      expect(res.body).not.toContain('QA tools');
      expect(res.body).not.toContain(v1);
    }
  });
  it("API key of B (any scopes) gets 404 on every project route of A, and A's key gets 404 on B's project", async () => {
    const kb = await mkKey('bob', ['builder:read', 'builder:write'], B());
    for (const r of ROUTES.filter((x) => x.url('x').includes('/projects/')))
      expect((await withKey(kb, r, pid)).statusCode, `${r.m} ${r.url(pid)}`).toBe(404);
    const ka = await mkKey('alice', ['builder:read', 'builder:write'], A());
    for (const r of ROUTES.filter((x) => x.url('x').includes('/projects/')))
      expect((await withKey(ka, r, bpid)).statusCode, `${r.m} ${r.url(bpid)}`).toBe(404);
  });
  it("A's API key cannot name organization B in the path or the header to reach B's data", async () => {
    const ka = await mkKey('alice', ['builder:read'], A());
    const res = await e.app.inject({
      method: 'GET',
      url: `/v1/builder/projects/${bpid}/review`,
      headers: { authorization: `Bearer ${ka}`, 'x-nuzm-org': B() },
    });
    expect(res.statusCode).toBe(404);
  });
  it('version ids of another project or organization are not readable through the diff route', async () => {
    const other = await ports.listVersions(B(), bpid);
    const res = await e.call(
      'alice',
      'GET',
      `/v1/builder/projects/${pid}/version-diff?from=${other[0]!.id}&to=${v2}`,
      undefined,
      A(),
    );
    expect([404, 422]).toContain(res.statusCode);
    expect(res.body).not.toContain('qa app');
  });
});

describe('QA builder tools: the dry-run routes write nothing (no Idempotency-Key needed)', () => {
  it('plan-previews and change-previews leave versions, changes, model usage, metering, operations, audit and Git untouched', async () => {
    const snap = async () => ({
      versions: await count(
        `SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`,
      ),
      changes: await count(`SELECT count(*) n FROM builder.changes WHERE project_id='${pid}'`),
      usage: await count(`SELECT count(*) n FROM ai.model_usage`),
      metering: await count(`SELECT count(*) n FROM metering.usage_events`),
      ops: await count(`SELECT count(*) n FROM platform.operations`),
      reservations: await count(`SELECT count(*) n FROM ai.reservations`),
      audit: e.sink.events.length,
      head: (await e.sql(`SELECT head_version_id FROM builder.projects WHERE id='${pid}'`))[0]!
        .head_version_id,
    });
    const before = await snap();
    for (let i = 0; i < 3; i++) {
      for (const r of ROUTES.slice(0, 2)) {
        const res = await call('alice', r, pid);
        expect(res.statusCode, `${r.url(pid)} ${res.body.slice(0, 160)}`).toBe(200);
      }
    }
    expect(await snap()).toEqual(before);
  });
  it('the same dry run twice gives the same answer (pure)', async () => {
    const a = await call('alice', ROUTES[1]!, pid);
    const b = await call('alice', ROUTES[1]!, pid);
    expect(a.json()).toEqual(b.json());
  });
  it('a preview does not hide a refusal: a stale base is 409/422, a secret-looking content is rejected, nothing stored', async () => {
    const stale = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${pid}/change-previews`,
      { baseVersion: randomUUID(), patches: [{ op: 'add', path: 'a.ts', content: '1' }] },
      A(),
    );
    expect([409, 422]).toContain(stale.statusCode);
    const secret = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${pid}/change-previews`,
      {
        patches: [
          {
            op: 'add',
            path: 'src/k.ts',
            content: ['const k = "AKIA', 'ABCDEFGHIJKLMNOP";'].join(''),
          },
        ],
      },
      A(),
    );
    expect(secret.statusCode === 200 ? j(secret).ok : false).not.toBe(true);
    const trav = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${pid}/change-previews`,
      { patches: [{ op: 'add', path: '../../etc/x', content: '1' }] },
      A(),
    );
    expect(trav.statusCode === 200 ? j(trav).ok : false).not.toBe(true);
  });
});

describe('QA builder tools: write routes are idempotent and honest', () => {
  it('memory: the same Idempotency-Key twice creates ONE entry and ONE version; the viewer sees it; the viewer cannot forget it', async () => {
    const mem = ROUTES.find((x) => x.m === 'POST' && x.url('x').endsWith('/memory'))!;
    const key = `idem-${randomUUID()}`;
    const first = await e.call('alice', 'POST', mem.url(pid), mem.body!(), A(), {
      'idempotency-key': key,
    });
    expect(first.statusCode, first.body.slice(0, 200)).toBe(201);
    const versions = await count(
      `SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`,
    );
    const second = await e.call('alice', 'POST', mem.url(pid), mem.body!(), A(), {
      'idempotency-key': key,
    });
    expect(second.statusCode).toBe(first.statusCode);
    expect(
      await count(`SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`),
    ).toBe(versions);
    const seen = await e.call('carol', 'GET', `/v1/builder/projects/${pid}/memory`, undefined, A());
    expect(seen.statusCode).toBe(200);
    expect(JSON.stringify(seen.json())).toContain('qa note');
    const entryId = JSON.stringify(seen.json()).match(/"id":"([0-9a-f-]{36})"/)?.[1];
    if (entryId)
      expect(
        (
          await e.call(
            'carol',
            'DELETE',
            `/v1/builder/projects/${pid}/memory/${entryId}`,
            undefined,
            A(),
          )
        ).statusCode,
      ).toBe(403);
  });
  it('memory refuses secrets and oversize text (4xx, never stored, never echoed)', async () => {
    const mem = ROUTES.find((x) => x.m === 'POST' && x.url('x').endsWith('/memory'))!;
    const versions = await count(
      `SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`,
    );
    const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    for (const body of [
      { kind: 'decision', text: `use key ${key}` },
      { kind: 'decision', text: 'x'.repeat(100_000) },
      { kind: 'nope', text: 'a' },
      { text: 1 },
      {},
    ]) {
      const res = await e.call('alice', 'POST', mem.url(pid), body, A());
      expect(res.statusCode, JSON.stringify(body).slice(0, 60)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toContain(key);
    }
    expect(
      await count(`SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`),
    ).toBe(versions);
  });
  it('rollback and revert: a stale base is refused and history is untouched; malformed ids are 4xx', async () => {
    const versions = await count(
      `SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`,
    );
    const stale = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${pid}/rollbacks`,
      { targetVersion: v1, baseVersion: randomUUID() },
      A(),
    );
    expect([409, 422]).toContain(stale.statusCode);
    for (const [path, body] of [
      ['rollbacks', { targetVersion: 'not-a-uuid' }],
      ['rollbacks', {}],
      ['rollbacks', { targetVersion: randomUUID() }],
      ['reverts', { versionId: 'x' }],
      ['reverts', { versionId: randomUUID() }],
    ] as const) {
      const res = await e.call('alice', 'POST', `/v1/builder/projects/${pid}/${path}`, body, A());
      expect(res.statusCode, `${path} ${JSON.stringify(body)}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, `${path} ${JSON.stringify(body)}`).toBeLessThan(500);
    }
    expect(
      await count(`SELECT count(*) n FROM builder.project_versions WHERE project_id='${pid}'`),
    ).toBe(versions);
  });
  it('a rollback by a developer creates a NEW restore version (history is never rewritten) and is audited', async () => {
    const before = await ports.listVersions(A(), pid);
    const head = (await e.sql(`SELECT head_version_id FROM builder.projects WHERE id='${pid}'`))[0]!
      .head_version_id as string;
    const res = await e.call(
      'dave',
      'POST',
      `/v1/builder/projects/${pid}/rollbacks`,
      { targetVersion: v1, baseVersion: head },
      A(),
    );
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    const after = await ports.listVersions(A(), pid);
    expect(after.length).toBe(before.length + 1);
    expect(after.find((v) => v.id === j(res).versionId)!.source).toBe('restore');
    for (const v of before) expect(after.map((x) => x.id)).toContain(v.id);
    expect(e.sink.events.some((x) => x.action === 'builder.change.rolled_back')).toBe(true);
  });
});
