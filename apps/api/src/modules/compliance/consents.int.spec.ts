import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { ConsentService, selfRef } from './index';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
const h = new Harness();
let app: App;
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};
const P = 'marketing_email';
const V = 'placeholder-1';

const call = (
  who: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: object,
  org = orgA,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf ?? '',
      'x-nuzm-org': org,
      'idempotency-key': `k-${Math.random()}`,
      ...extra,
    },
    ...(body ? { payload: body } : {}),
  });
const grant = (who: string, extra: Row = {}, org = orgA, headers: Record<string, string> = {}) =>
  call(
    who,
    'POST',
    '/v1/compliance/consents',
    { purposeId: P, granted: true, localeShown: 'en', textVersion: V, ...extra },
    org,
    headers,
  );
const mk = async (who: string, name: string) =>
  (
    await app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
      payload: { name },
    })
  ).json().id as string;
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);
const rows = (org = orgA) =>
  count(`SELECT count(*) n FROM compliance.consents WHERE org_id = $1`, [org]);

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  for (const n of ['alice', 'bob', 'carol', 'dave']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
    await h.elevate(jars[n]!);
  }
  orgA = await mk('alice', 'Consent A');
  orgB = await mk('bob', 'Consent B');
  for (const [u, role] of [
    ['carol', 'viewer'],
    ['dave', 'developer'],
  ] as const)
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
      [orgA, ids[u], role],
    );
});
afterAll(() => h.close());

describe('grant', () => {
  it('records a grant for the caller (any member, even a viewer): append-only row, opaque subject, current wording', async () => {
    const r = await grant('carol');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      purposeId: P,
      subjectRef: selfRef(ids.carol!),
      state: 'granted',
      textVersion: V,
      locale: 'en',
      source: 'ui',
      withdrawsId: null,
    });
    expect(r.json().subjectRef).not.toContain('@');
  });
  it('granting again with the same wording answers 200 with the same record and writes no row', async () => {
    const before = await rows();
    const first = await grant('dave');
    const again = await grant('dave');
    expect(first.statusCode).toBe(201);
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.json().id);
    expect(await rows()).toBe(before + 1);
  });
  it('is idempotent per Idempotency-Key (same key, same body: the first response replays)', async () => {
    const before = await rows();
    const key = { 'idempotency-key': 'consent-replay-1' };
    const a = await grant('alice', { subjectRef: 'end-user-replay' }, orgA, key);
    const b = await grant('alice', { subjectRef: 'end-user-replay' }, orgA, key);
    expect(a.statusCode).toBe(201);
    expect(b.json().id).toBe(a.json().id);
    expect(await rows()).toBe(before + 1);
  });
  it.each([
    ['an unknown purpose', { purposeId: 'sell_data_to_everyone' }, 409, 'consent_purpose_unknown'],
    ['a stale text version', { textVersion: 'old-text' }, 422, 'validation_failed'],
    ['granted: false', { granted: false }, 422, 'validation_failed'],
    ['no locale shown', { localeShown: 'fr' }, 422, 'validation_failed'],
    ['an email as subject', { subjectRef: 'someone@example.com' }, 422, 'validation_failed'],
  ])('refuses %s', async (_n, extra, status, code) => {
    const r = await grant('alice', extra as Row);
    expect(r.statusCode).toBe(status);
    expect(r.json().code ?? r.json().type).toContain(code);
  });
  it('members cannot act for another subject; owners and admins can (end users and the organization itself)', async () => {
    expect((await grant('carol', { subjectRef: 'end-user-9' })).statusCode).toBe(403);
    expect((await grant('carol', { subjectRef: 'org' })).statusCode).toBe(403);
    expect((await grant('carol', { subjectRef: selfRef(ids.carol!) })).statusCode).toBe(200); // own ref is fine
    expect((await grant('alice', { subjectRef: 'end-user-9' })).statusCode).toBe(201);
    expect((await grant('alice', { subjectRef: 'org' })).statusCode).toBe(201);
  });
  it('is audited', async () => {
    const n = await count(
      `SELECT count(*) n FROM audit.audit_logs WHERE org_id = $1 AND action = 'compliance.consent.granted'`,
      [orgA],
    );
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe('withdraw', () => {
  it('records a withdrawn entry, keeps the row, and the next read sees it', async () => {
    const g = await grant('alice', { subjectRef: 'end-user-w1' });
    const before = await rows();
    const w = await call('alice', 'DELETE', `/v1/compliance/consents/${g.json().id}`);
    expect(w.statusCode).toBe(204);
    expect(await rows()).toBe(before + 1);
    const cur = await call('alice', 'GET', '/v1/compliance/consents?subject=end-user-w1');
    expect(cur.json().items).toHaveLength(1);
    expect(cur.json().items[0]).toMatchObject({ state: 'withdrawn', withdrawsId: g.json().id });
    const hist = await call(
      'alice',
      'GET',
      '/v1/compliance/consents?subject=end-user-w1&history=true',
    );
    expect(
      hist
        .json()
        .items.map((x: Row) => x.state)
        .sort(),
    ).toEqual(['granted', 'withdrawn']);
    expect(
      await count(`SELECT count(*) n FROM compliance.consents WHERE id = $1`, [g.json().id]),
    ).toBe(1); // the grant is retained
  });
  it('withdrawing twice changes nothing; a new grant after a withdrawal is a new row with a higher seq', async () => {
    const g = await grant('alice', { subjectRef: 'end-user-w2' });
    await call('alice', 'DELETE', `/v1/compliance/consents/${g.json().id}`);
    const before = await rows();
    expect(
      (await call('alice', 'DELETE', `/v1/compliance/consents/${g.json().id}`)).statusCode,
    ).toBe(204);
    expect(await rows()).toBe(before);
    expect((await grant('alice', { subjectRef: 'end-user-w2' })).statusCode).toBe(201);
    const seqs = await h.env.sql(
      `SELECT seq FROM compliance.consents WHERE org_id = $1 AND subject_ref = 'end-user-w2' ORDER BY seq`,
      [orgA],
    );
    expect(seqs.map((r) => Number(r.seq))).toEqual([1, 2, 3]);
  });
  it('withdrawing through an older grant id still ends the CURRENT consent', async () => {
    const g1 = await grant('alice', { subjectRef: 'end-user-w3' });
    await call('alice', 'DELETE', `/v1/compliance/consents/${g1.json().id}`);
    await grant('alice', { subjectRef: 'end-user-w3' });
    await call('alice', 'DELETE', `/v1/compliance/consents/${g1.json().id}`); // the OLD id
    const cur = await call('alice', 'GET', '/v1/compliance/consents?subject=end-user-w3');
    expect(cur.json().items[0].state).toBe('withdrawn');
  });
  it('a member cannot withdraw someone else’s consent (404: existence is not revealed); unknown ids are 404', async () => {
    const g = await grant('alice', { subjectRef: 'end-user-w4' });
    expect(
      (await call('carol', 'DELETE', `/v1/compliance/consents/${g.json().id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'alice',
          'DELETE',
          `/v1/compliance/consents/00000000-0000-4000-8000-000000000000`,
        )
      ).statusCode,
    ).toBe(404);
    expect((await call('alice', 'DELETE', `/v1/compliance/consents/not-a-uuid`)).statusCode).toBe(
      404,
    );
  });
  it('the history cannot be updated or deleted, even by the database owner (append-only trigger)', async () => {
    const id = (await grant('alice', { subjectRef: 'end-user-w5' })).json().id;
    await expect(
      h.env.sql(`UPDATE compliance.consents SET state = 'withdrawn' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(h.env.sql(`DELETE FROM compliance.consents WHERE id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
    await expect(h.env.sql(`TRUNCATE compliance.consents`)).rejects.toThrow(/append-only/);
  });
  it('is audited', async () => {
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE org_id = $1 AND action = 'compliance.consent.withdrawn'`,
        [orgA],
      ),
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('list', () => {
  it('a member sees only their own consents and gets 403 when asking for another subject', async () => {
    await grant('carol');
    const mine = await call('carol', 'GET', '/v1/compliance/consents');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items.length).toBeGreaterThan(0);
    for (const c of mine.json().items) expect(c.subjectRef).toBe(selfRef(ids.carol!));
    expect(
      (await call('carol', 'GET', '/v1/compliance/consents?subject=end-user-9')).statusCode,
    ).toBe(403);
  });
  it('the owner sees every subject of the organization; status filters the CURRENT state', async () => {
    const all = await call('alice', 'GET', '/v1/compliance/consents?limit=200');
    const subjects = new Set(all.json().items.map((x: Row) => x.subjectRef));
    expect(subjects.has(selfRef(ids.carol!))).toBe(true);
    expect(subjects.has('end-user-9')).toBe(true);
    const withdrawn = await call(
      'alice',
      'GET',
      '/v1/compliance/consents?status=withdrawn&limit=200',
    );
    for (const c of withdrawn.json().items) expect(c.state).toBe('withdrawn');
    const granted = await call('alice', 'GET', '/v1/compliance/consents?status=granted&limit=200');
    for (const c of granted.json().items) expect(c.state).toBe('granted');
    expect((await call('alice', 'GET', '/v1/compliance/consents?status=maybe')).statusCode).toBe(
      422,
    );
  });
  it('paginates newest first without repeating or skipping', async () => {
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await call(
        'alice',
        'GET',
        `/v1/compliance/consents?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...r.json().items.map((x: Row) => x.id));
      if (!r.json().nextCursor) break;
      cursor = r.json().nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const total = (await call('alice', 'GET', '/v1/compliance/consents?limit=200')).json().items
      .length;
    expect(seen.length).toBe(total);
    expect([...seen].sort().reverse()).toEqual(seen);
  });
});

describe('cross-tenant', () => {
  it('another organization sees nothing, cannot withdraw, and RLS blocks a direct read', async () => {
    const g = await grant('alice', { subjectRef: 'end-user-x1' });
    expect(
      (await call('bob', 'GET', '/v1/compliance/consents', undefined, orgB)).json().items,
    ).toEqual([]);
    expect(
      (await call('bob', 'DELETE', `/v1/compliance/consents/${g.json().id}`, undefined, orgB))
        .statusCode,
    ).toBe(404);
    expect((await call('bob', 'GET', '/v1/compliance/consents', undefined, orgA)).statusCode).toBe(
      404,
    ); // not a member of A: the organization's existence is hidden
    // an organization's database session cannot read another organization's rows even with a hand-written query (forced RLS)
    const own = await h.env.app.withOrg(orgB, (c) =>
      c.query(`SELECT count(*)::int n FROM compliance.consents`),
    );
    expect(own.rows[0].n).toBe(0);
    const asA = await h.env.app.withOrg(orgA, (c) =>
      c.query(`SELECT count(*)::int n FROM compliance.consents`),
    );
    expect(asA.rows[0].n).toBeGreaterThan(0);
  });
});

describe('isAllowed (the question other modules ask)', () => {
  it('is true only while the latest record is a grant, and fails closed on bad input', async () => {
    const svc = app.get(ConsentService);
    const subject = 'end-user-allow';
    expect(await svc.isAllowed(orgA, subject, P)).toBe(false); // nothing recorded
    const g = await grant('alice', { subjectRef: subject });
    expect(await svc.isAllowed(orgA, subject, P)).toBe(true);
    expect(await svc.isAllowed(orgB, subject, P)).toBe(false); // another organization
    await call('alice', 'DELETE', `/v1/compliance/consents/${g.json().id}`);
    expect(await svc.isAllowed(orgA, subject, P)).toBe(false);
    expect(await svc.isAllowed(orgA, subject, 'no_such_purpose')).toBe(false);
    expect(await svc.isAllowed(orgA, 'bad subject!', P)).toBe(false);
  });
});

describe('concurrency (AC-M04-05)', () => {
  it('1,000 operations: a withdrawal is effective on the very next isAllowed (0 stale reads) while 50 subjects run in parallel', async () => {
    const svc = app.get(ConsentService);
    const caller = { userId: ids.alice!, canManage: true, via: 'session' as const };
    let stale = 0;
    let ops = 0;
    await Promise.all(
      Array.from({ length: 50 }, async (_x, i) => {
        const subject = `conc-${i}`;
        for (let k = 0; k < 5; k++) {
          const { consent } = await svc.grant(orgA, caller, {
            purposeId: P,
            granted: true,
            localeShown: 'ar',
            textVersion: V,
            subjectRef: subject,
          });
          ops++;
          if (!(await svc.isAllowed(orgA, subject, P))) stale++;
          ops++;
          await svc.withdraw(orgA, caller, consent.id);
          ops++;
          if (await svc.isAllowed(orgA, subject, P)) stale++;
          ops++;
        }
      }),
    );
    expect(ops).toBe(1000);
    expect(stale).toBe(0);
  });
  it('ten simultaneous grants of the same consent write exactly one row; seq stays contiguous under a grant/withdraw race', async () => {
    const svc = app.get(ConsentService);
    const caller = { userId: ids.alice!, canManage: true, via: 'session' as const };
    const body = {
      purposeId: P,
      granted: true,
      localeShown: 'en',
      textVersion: V,
      subjectRef: 'race-1',
    };
    const rs = await Promise.all(Array.from({ length: 10 }, () => svc.grant(orgA, caller, body)));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.consent.id)).size).toBe(1);
    const first = rs[0]!.consent.id;
    await Promise.all([
      ...Array.from({ length: 5 }, () => svc.withdraw(orgA, caller, first)),
      ...Array.from({ length: 5 }, () =>
        svc.grant(orgA, caller, { ...body, subjectRef: 'race-1' }),
      ),
    ]);
    const seqs = (
      await h.env.sql(
        `SELECT seq FROM compliance.consents WHERE org_id = $1 AND subject_ref = 'race-1' ORDER BY seq`,
        [orgA],
      )
    ).map((r) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_s, i) => i + 1)); // no gaps, no duplicates
    const states = (
      await h.env.sql(
        `SELECT state FROM compliance.consents WHERE org_id = $1 AND subject_ref = 'race-1' ORDER BY seq`,
        [orgA],
      )
    ).map((r) => r.state);
    for (let i = 1; i < states.length; i++)
      expect(states[i], `row ${i + 1}`).not.toBe(states[i - 1]); // never two grants or two withdrawals in a row
  });
});
