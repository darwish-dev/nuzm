import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests */
type Row = Record<string, any>;
/** The adapter kinds of docs/09 §1 (the document is read, never edited). */
const adapterKindsFromDocs = (text: string): string[] => {
  const m = /readonly kind:\s*((?:'[a-z-]+'\s*\|?\s*)+)/.exec(text);
  return m ? [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!) : [];
};
const h = new Harness();
let app: App;
const staff: Record<string, { id: string; jar: Record<string, string> }> = {};
let seq = 0;

const admin = (
  who: string,
  method: 'GET' | 'POST',
  url: string,
  body?: object,
  key?: string | null,
) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(staff[who]!.jar),
      'x-csrf-token': staff[who]!.jar.nuzm_admin_csrf!,
      ...(key === null ? {} : { 'idempotency-key': key ?? `k-${++seq}-${Math.random()}` }),
    },
    ...(body ? { payload: body } : {}),
  });
const entry = (over: Row = {}): Row => ({
  entryKey: 'activity:support-desk',
  kind: 'activity',
  activity: 'Customer support desk',
  purpose: 'Answer customer questions',
  dataClasses: ['personal'],
  processors: [],
  regions: ['SA'],
  ...over,
});
const count = async (q: string, p: unknown[] = []) => Number((await h.env.sql(q, p))[0]!.n);

beforeAll(async () => {
  await h.init();
  ({ app } = await h.buildApp({}, undefined, [], { realAudit: true }));
  staff.officer = await h.platformUser(app, 'officer', ['compliance_officer']);
  staff.root = await h.platformUser(app, 'root', ['platform_admin']);
  staff.sec = await h.platformUser(app, 'sec', ['security']);
  staff.support = await h.platformUser(app, 'support', ['support']);
  staff.finance = await h.platformUser(app, 'finance', ['finance']);
});
afterAll(() => h.close());

describe('seeded placeholders', () => {
  it('has a current placeholder for every adapter kind of docs/09 and for every platform activity, naming no processor', async () => {
    const kinds = adapterKindsFromDocs(
      readFileSync(
        join(__dirname, '../../../../../docs/09-provider-adapter-interfaces.md'),
        'utf8',
      ),
    );
    expect(kinds).toHaveLength(11);
    const r = await admin('officer', 'GET', '/v1/admin/compliance/ropa?limit=200');
    expect(r.statusCode).toBe(200);
    const items: Row[] = r.json().items;
    for (const k of kinds) {
      const e = items.find((x) => x.adapterKind === k);
      expect(e, k).toBeDefined();
      expect(e).toMatchObject({
        kind: 'adapter',
        version: 1,
        status: 'placeholder',
        createdBy: null,
        processors: [],
      });
    }
    expect(items.filter((x) => x.kind === 'activity').length).toBeGreaterThanOrEqual(5);
    for (const x of items) expect(x.status).toBe('placeholder');
  });
  it('filters by kind, adapterKind and status, and paginates without repeating', async () => {
    const adapters = (
      await admin('officer', 'GET', '/v1/admin/compliance/ropa?kind=adapter&limit=200')
    ).json().items;
    expect(adapters).toHaveLength(11);
    const psp = (await admin('officer', 'GET', '/v1/admin/compliance/ropa?adapterKind=psp')).json()
      .items;
    expect(psp).toHaveLength(1);
    expect(psp[0].entryKey).toBe('adapter:psp');
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await admin(
        'officer',
        'GET',
        `/v1/admin/compliance/ropa?limit=4${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...r.json().items.map((x: Row) => x.entryKey));
      if (!r.json().nextCursor) break;
      cursor = r.json().nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(16);
    expect(
      (await admin('officer', 'GET', '/v1/admin/compliance/ropa?status=bogus')).statusCode,
    ).toBe(422);
    expect(
      (await admin('officer', 'GET', '/v1/admin/compliance/ropa?history=true')).statusCode,
    ).toBe(422);
  });
});

describe('access', () => {
  it('compliance officers, platform admins and security read; support and finance do not; the customer realm cannot reach it', async () => {
    for (const who of ['officer', 'root', 'sec'])
      expect((await admin(who, 'GET', '/v1/admin/compliance/ropa')).statusCode, who).toBe(200);
    for (const who of ['support', 'finance'])
      expect((await admin(who, 'GET', '/v1/admin/compliance/ropa')).statusCode, who).toBe(403);
    const customer = await h.createUser('cust');
    const jar = await h.sessionFor(app, customer);
    const r = await app.inject({
      method: 'GET',
      url: '/v1/admin/compliance/ropa',
      headers: { cookie: cookieHeader(jar) },
    });
    expect([401, 403]).toContain(r.statusCode);
  });
  it('writing needs admin:compliance:manage, an Idempotency-Key and a recent MFA check', async () => {
    expect((await admin('sec', 'POST', '/v1/admin/compliance/ropa', entry())).statusCode).toBe(403); // read-only role
    expect(
      (await admin('officer', 'POST', '/v1/admin/compliance/ropa', entry(), null)).statusCode,
    ).toBe(400);
    const stale = await h.platformUser(app, 'stale-officer', ['compliance_officer']);
    await h.env.sql(
      `UPDATE identity.sessions SET mfa_verified_at = now() - interval '3 hours' WHERE user_id = $1`,
      [stale.id],
    );
    staff.stale = stale;
    const r = await admin(
      'stale',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({ entryKey: 'activity:stale-check' }),
    );
    expect(r.statusCode).toBe(401);
    expect(r.json().code ?? r.json().type).toContain('step_up_required');
  });
});

describe('create, replay and version', () => {
  it('creates an entry as a draft written by the caller, and audits it', async () => {
    const r = await admin('officer', 'POST', '/v1/admin/compliance/ropa', entry(), 'create-1');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({
      entryKey: 'activity:support-desk',
      version: 1,
      status: 'draft',
      createdBy: staff.officer!.id,
      reviewedBy: null,
    });
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.ropa.created'`,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
  it('the same Idempotency-Key and content replays (200, same id, no new row); other content with that key is 422', async () => {
    const before = await count(`SELECT count(*) n FROM compliance.ropa_entries`);
    const again = await admin('officer', 'POST', '/v1/admin/compliance/ropa', entry(), 'create-1');
    expect(again.statusCode).toBe(200);
    expect(await count(`SELECT count(*) n FROM compliance.ropa_entries`)).toBe(before);
    const other = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({ purpose: 'Something else' }),
      'create-1',
    );
    expect(other.statusCode).toBe(422);
    expect(other.json().code ?? other.json().type).toContain('idempotency_key_reuse');
  });
  it('a new version needs the current baseVersion; stale, missing and premature base versions are 409', async () => {
    const v2 = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({
        baseVersion: 1,
        purpose: 'Answer customer questions by email and chat',
        changeNote: 'added chat',
      }),
    );
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ version: 2, changeNote: 'added chat' });
    expect(
      (await admin('officer', 'POST', '/v1/admin/compliance/ropa', entry({ baseVersion: 1 })))
        .statusCode,
    ).toBe(409); // stale
    expect((await admin('officer', 'POST', '/v1/admin/compliance/ropa', entry())).statusCode).toBe(
      409,
    ); // exists: needs baseVersion
    expect(
      (
        await admin(
          'officer',
          'POST',
          '/v1/admin/compliance/ropa',
          entry({ entryKey: 'activity:new-one', baseVersion: 1 }),
        )
      ).statusCode,
    ).toBe(409); // does not exist
    const cur = (
      await admin('officer', 'GET', '/v1/admin/compliance/ropa?entryKey=activity:support-desk')
    ).json().items;
    expect(cur).toHaveLength(1);
    expect(cur[0].version).toBe(2);
    const hist = (
      await admin(
        'officer',
        'GET',
        '/v1/admin/compliance/ropa?entryKey=activity:support-desk&history=true',
      )
    ).json().items;
    expect(hist.map((x: Row) => x.version).sort()).toEqual([1, 2]);
  });
  it('the kind of an entry is fixed; a new entry needs a kind', async () => {
    expect(
      (
        await admin(
          'officer',
          'POST',
          '/v1/admin/compliance/ropa',
          entry({ baseVersion: 2, kind: 'adapter', adapterKind: 'psp' }),
        )
      ).statusCode,
    ).toBe(422);
    const noKind = entry({ entryKey: 'activity:no-kind' });
    delete noKind.kind;
    expect((await admin('officer', 'POST', '/v1/admin/compliance/ropa', noKind)).statusCode).toBe(
      422,
    );
  });
  it('an adapter entry for a new kind is possible and keeps its adapter kind across versions', async () => {
    const a = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({
        entryKey: 'adapter:sms',
        kind: 'adapter',
        adapterKind: 'sms',
        activity: 'SMS gateway',
        dataClasses: ['personal'],
      }),
    );
    expect(a.statusCode).toBe(201);
    const b = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({
        entryKey: 'adapter:sms',
        kind: 'adapter',
        adapterKind: 'sms',
        baseVersion: 1,
        activity: 'SMS gateway (updated)',
        dataClasses: ['personal'],
      }),
    );
    expect(b.statusCode).toBe(201);
    expect(b.json()).toMatchObject({ kind: 'adapter', adapterKind: 'sms', version: 2 });
  });
  it('rejects an unknown data class (entry or processor) and a bad processor with field details', async () => {
    const u = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({ entryKey: 'activity:bad-class', dataClasses: ['secret-stuff'] }),
    );
    expect(u.statusCode).toBe(422);
    const p = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({
        entryKey: 'activity:bad-proc',
        processors: [{ name: 'X', role: 'processor', region: 'SA', dataClasses: ['nope'] }],
      }),
    );
    expect(p.statusCode).toBe(422);
    const f = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({
        entryKey: 'activity:bad-region',
        processors: [{ name: 'X', role: 'boss', region: 'Saudi', dataClasses: ['personal'] }],
      }),
    );
    expect(f.statusCode).toBe(422);
    expect(JSON.stringify(f.json())).toContain('processors[0].role');
  });
});

describe('review (four-eyes)', () => {
  it('the author cannot review; a different person can, with identical content; changed content is refused', async () => {
    const created = await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({ entryKey: 'activity:review-me' }),
    );
    expect(created.statusCode).toBe(201);
    const same = entry({ entryKey: 'activity:review-me', baseVersion: 1, status: 'reviewed' });
    expect((await admin('officer', 'POST', '/v1/admin/compliance/ropa', same)).statusCode).toBe(
      403,
    ); // the author
    expect(
      (
        await admin('root', 'POST', '/v1/admin/compliance/ropa', {
          ...same,
          purpose: 'changed while reviewing',
        })
      ).statusCode,
    ).toBe(422);
    const ok = await admin('root', 'POST', '/v1/admin/compliance/ropa', same);
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ version: 2, status: 'reviewed', reviewedBy: staff.root!.id });
    expect(
      await count(
        `SELECT count(*) n FROM audit.audit_logs WHERE action = 'compliance.ropa.reviewed'`,
      ),
    ).toBe(1);
  });
  it('a brand-new entry cannot start as reviewed', async () => {
    expect(
      (
        await admin(
          'root',
          'POST',
          '/v1/admin/compliance/ropa',
          entry({ entryKey: 'activity:born-reviewed', status: 'reviewed' }),
        )
      ).statusCode,
    ).toBe(422);
  });
  it('a placeholder can be completed by a person and then reviewed by another', async () => {
    const cur = (await admin('officer', 'GET', '/v1/admin/compliance/ropa?adapterKind=psp')).json()
      .items[0];
    const draft = await admin('officer', 'POST', '/v1/admin/compliance/ropa', {
      entryKey: 'adapter:psp',
      baseVersion: cur.version,
      activity: cur.activity,
      purpose: cur.purpose,
      dataClasses: cur.dataClasses,
      processors: [
        {
          name: 'Example PSP (sandbox)',
          role: 'processor',
          region: 'SA',
          dataClasses: ['financial'],
          contractRef: 'DPA-PENDING',
        },
      ],
      regions: ['SA'],
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ version: 2, status: 'draft' });
    expect(draft.json().processors).toHaveLength(1);
  });
});

describe('immutability and concurrency', () => {
  it('rows cannot be updated, deleted or truncated, even by the database owner; versions cannot skip; unknown classes are refused by the database', async () => {
    await expect(
      h.env.sql(`UPDATE compliance.ropa_entries SET purpose = 'x' WHERE entry_key = 'adapter:psp'`),
    ).rejects.toThrow(/versioned/);
    await expect(
      h.env.sql(`DELETE FROM compliance.ropa_entries WHERE entry_key = 'adapter:psp'`),
    ).rejects.toThrow(/versioned/);
    await expect(h.env.sql(`TRUNCATE compliance.ropa_entries`)).rejects.toThrow(/versioned/);
    const ins = (v: number, classes = '{personal}') =>
      h.env.sql(
        `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, activity, purpose, data_classes, status) VALUES (gen_random_uuid(),'activity:skip',$1,'activity','a','p',$2,'draft')`,
        [v, classes],
      );
    await expect(ins(2)).rejects.toThrow(/must follow version/);
    await ins(1);
    await expect(ins(1)).rejects.toThrow(/already exists/);
    await expect(ins(3)).rejects.toThrow(/must follow version/);
    await expect(
      h.env.sql(
        `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, activity, purpose, data_classes, status) VALUES (gen_random_uuid(),'activity:badclass',1,'activity','a','p','{nonsense}','draft')`,
      ),
    ).rejects.toThrow(/unknown data class/);
    await expect(
      h.env.sql(
        `INSERT INTO compliance.ropa_entries (id, entry_key, version, kind, activity, purpose, data_classes, status) VALUES (gen_random_uuid(),'activity:rev',1,'activity','a','p','{personal}','reviewed')`,
      ),
    ).rejects.toThrow(/reviewed_by|check/);
  });
  it('five simultaneous saves of the same version: exactly one wins, the others are 409', async () => {
    await admin(
      'officer',
      'POST',
      '/v1/admin/compliance/ropa',
      entry({ entryKey: 'activity:race' }),
    );
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_x, i) =>
        admin(
          'officer',
          'POST',
          '/v1/admin/compliance/ropa',
          entry({ entryKey: 'activity:race', baseVersion: 1, purpose: `variant ${i}` }),
        ),
      ),
    );
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(4);
    expect(
      await count(
        `SELECT count(*) n FROM compliance.ropa_entries WHERE entry_key = 'activity:race'`,
      ),
    ).toBe(2);
  });
  it('the application role sees nothing without the admin scope (forced RLS)', async () => {
    const r = await h.env.app.withoutScope((c) =>
      c.query(`SELECT count(*)::int n FROM compliance.ropa_entries`),
    );
    expect(r.rows[0].n).toBe(0);
    const a = await h.env.app.withPlatformScope((c) =>
      c.query(`SELECT count(*)::int n FROM compliance.ropa_entries`),
    );
    expect(a.rows[0].n).toBeGreaterThan(10);
  });
});
