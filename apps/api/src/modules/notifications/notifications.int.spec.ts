import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { NotificationService } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed JSON rows in tests
type Row = Record<string, any>;

const h = new Harness();
let app: App;
let svc: NotificationService;
let mailer: Awaited<ReturnType<Harness['buildApp']>>['mailer'];
let orgA = '';
let orgB = '';
const ids: Record<string, string> = {};
const jars: Record<string, Record<string, string>> = {};

const call = (who: string, method: 'GET' | 'PATCH', url: string, org: string, body?: object) =>
  app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(jars[who]!),
      'x-csrf-token': jars[who]!.nuzm_csrf!,
      'x-nuzm-org': org,
    },
    ...(body ? { payload: body } : {}),
  });
const list = async (who: string, org: string, q = '') =>
  (await call(who, 'GET', `/v1/notifications${q}`, org)).json() as {
    items: { id: string; kind: string; readAt: string | null; params: Row }[];
    nextCursor: string | null;
    unreadCount: number;
  };

beforeAll(async () => {
  await h.init();
  const built = await h.buildApp();
  app = built.app;
  mailer = built.mailer;
  svc = app.get(NotificationService);
  for (const n of ['alice', 'bob', 'carol']) {
    ids[n] = await h.createUser(n);
    jars[n] = await h.sessionFor(app, ids[n]!);
  }
  const mk = async (who: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/v1/organizations',
        headers: { cookie: cookieHeader(jars[who]!), 'x-csrf-token': jars[who]!.nuzm_csrf! },
        payload: { name },
      })
    ).json().id as string;
  orgA = await mk('alice', 'Notif A');
  orgB = await mk('bob', 'Notif B');
  await h.env.sql(
    `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
    [orgA, ids.carol],
  );
});
afterAll(() => h.close());

describe('delivery and preferences', () => {
  it('in-app only by default; email stays off until the user opts in', async () => {
    await svc.notify({
      orgId: orgA,
      userId: ids.alice!,
      kind: 'billing.invoice_ready',
      params: { n: 1 },
    });
    expect((await list('alice', orgA)).items.map((i) => i.kind)).toContain('billing.invoice_ready');
    expect(mailer.sent.filter((m) => m.template === 'notification')).toHaveLength(0);

    await svc.setPreference(orgA, ids.alice!, 'billing.invoice_ready', 'email', true);
    await svc.notify({
      orgId: orgA,
      userId: ids.alice!,
      kind: 'billing.invoice_ready',
      params: { n: 2 },
    });
    const mails = mailer.sent.filter((m) => m.template === 'notification');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: 'alice@example.test',
      locale: 'ar',
      data: { kind: 'billing.invoice_ready', params: { n: 2 } },
    });

    await svc.setPreference(orgA, ids.alice!, 'billing.invoice_ready', 'in_app', false);
    const before = (await list('alice', orgA)).items.length;
    await svc.notify({
      orgId: orgA,
      userId: ids.alice!,
      kind: 'billing.invoice_ready',
      params: { n: 3 },
    });
    expect((await list('alice', orgA)).items.length).toBe(before); // in-app switched off
  });

  it('security notices ignore preferences, cannot be disabled, and always reach email too', async () => {
    await expect(
      svc.setPreference(orgA, ids.alice!, 'security.impersonation_started', 'in_app', false),
    ).rejects.toMatchObject({ code: 'conflict' });
    const mailsBefore = mailer.sent.length;
    await svc.notify({
      orgId: orgA,
      userId: ids.alice!,
      kind: 'security.impersonation_started',
      params: {},
    });
    expect((await list('alice', orgA)).items.map((i) => i.kind)).toContain(
      'security.impersonation_started',
    );
    expect(mailer.sent.length).toBe(mailsBefore + 1);
  });

  it('an email outage never loses the in-app notification; an unverified address is never mailed', async () => {
    mailer.failNext = true;
    await svc.notify({ orgId: orgA, userId: ids.alice!, kind: 'security.new_device', params: {} });
    expect((await list('alice', orgA)).items.map((i) => i.kind)).toContain('security.new_device');

    const u = await h.createUser('unverified', { emailVerified: false });
    await h.env.sql(
      `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, 'viewer')`,
      [orgA, u],
    );
    const n = mailer.sent.length;
    await svc.notify({ orgId: orgA, userId: u, kind: 'security.new_device', params: {} });
    expect(mailer.sent.length).toBe(n);
  });

  it('rejects malformed kinds and unknown channels', async () => {
    await expect(
      svc.notify({ orgId: orgA, userId: ids.alice!, kind: 'BadKind', params: {} }),
    ).rejects.toThrow(/invalid notification kind/);
    await expect(
      svc.setPreference(orgA, ids.alice!, 'x.y', 'sms' as never, true),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('GET/PATCH /v1/notifications', () => {
  it("lists only the caller's own notifications, with unread count and unread filter", async () => {
    await svc.notify({ orgId: orgA, userId: ids.carol!, kind: 'team.hello', params: {} });
    const carol = await list('carol', orgA);
    expect(carol.items.map((i) => i.kind)).toEqual(['team.hello']);
    expect(carol.unreadCount).toBe(1);
    const alice = await list('alice', orgA);
    expect(alice.items.map((i) => i.kind)).not.toContain('team.hello'); // a colleague's notice is invisible
    expect((await list('alice', orgA, '?unread=true')).items.every((i) => i.readAt === null)).toBe(
      true,
    );
  });

  it("marks read/unread; another user's notification and another org's are 404", async () => {
    const mine = (await list('carol', orgA)).items[0]!;
    const read = await call('carol', 'PATCH', `/v1/notifications/${mine.id}`, orgA, { read: true });
    expect(read.statusCode).toBe(200);
    expect(read.json().readAt).not.toBeNull();
    expect((await list('carol', orgA)).unreadCount).toBe(0);
    expect(
      (await call('carol', 'PATCH', `/v1/notifications/${mine.id}`, orgA, { read: false })).json()
        .readAt,
    ).toBeNull();
    // alice cannot touch carol's notification even inside the same org
    expect(
      (await call('alice', 'PATCH', `/v1/notifications/${mine.id}`, orgA, { read: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('bob', 'PATCH', `/v1/notifications/${mine.id}`, orgB, { read: true })).statusCode,
    ).toBe(404);
    expect(
      (await call('carol', 'PATCH', '/v1/notifications/not-a-uuid', orgA, { read: true }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('carol', 'PATCH', `/v1/notifications/${mine.id}`, orgA, { read: 'yes' as never }))
        .statusCode,
    ).toBe(422);
  });

  it('paginates by cursor without duplicates', async () => {
    for (let i = 0; i < 5; i++)
      await svc.notify({ orgId: orgB, userId: ids.bob!, kind: 'team.item', params: { i } });
    const first = await list('bob', orgB, '?limit=2');
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await list('bob', orgB, `?limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.id)).not.toEqual(
      expect.arrayContaining(first.items.map((i) => i.id)),
    );
  });

  it('API keys cannot read notifications (user sessions only)', async () => {
    await h.elevate(jars.alice!);
    const k = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: {
        cookie: cookieHeader(jars.alice!),
        'x-csrf-token': jars.alice!.nuzm_csrf!,
        'x-nuzm-org': orgA,
        'idempotency-key': 'nk',
      },
      payload: { name: 'n', scopes: ['org:read'] },
    });
    const r = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${k.json().key}` },
    });
    expect(r.statusCode).toBe(401);
  });
});
