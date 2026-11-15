import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnv, ORG_A, ORG_B, type TestEnv } from '@nuzm/platform/testing';
import { ApiKeyService } from './internal/api-key.service';

let env: TestEnv;
let svc: ApiKeyService;
const USER = '00000000-0000-7000-8000-0000000000aa';
const perms = new Set(['project:read', 'project:write']);

beforeAll(async () => {
  env = await createEnv();
  await env.sql(
    `INSERT INTO identity.users (id, issuer, subject, email) VALUES ($1,'iss','creator','c@example.test')`,
    [USER],
  );
  svc = new ApiKeyService(env.app, 0); // cache off: every call hits the database
});
afterAll(() => env.close());

describe('API keys', () => {
  it('shows the secret once, stores only an argon2id hash, and authenticates', async () => {
    const k = await svc.create(ORG_A, USER, { name: 'ci', scopes: ['project:read'] }, perms);
    expect(k.key).toMatch(/^nzk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    const row = (
      await env.sql(`SELECT prefix, secret_hash FROM identity.api_keys WHERE id=$1`, [k.id])
    )[0]!;
    expect(row.secret_hash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain(k.key.split('_').pop());
    const listed = JSON.stringify(await svc.list(ORG_A));
    expect(listed).not.toContain('secret');
    expect(await svc.authenticate(k.key, '203.0.113.1')).toMatchObject({
      orgId: ORG_A,
      scopes: ['project:read'],
      keyId: k.id,
      createdBy: USER,
    });
  });

  it('refuses scopes beyond the creator permissions (422) and bad inputs', async () => {
    await expect(
      svc.create(ORG_A, USER, { name: 'x', scopes: ['member:manage'] }, perms),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      svc.create(ORG_A, USER, { name: '', scopes: ['project:read'] }, perms),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(svc.create(ORG_A, USER, { name: 'x', scopes: [] }, perms)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      svc.create(
        ORG_A,
        USER,
        { name: 'x', scopes: ['project:read'], ipAllowList: ['not-an-ip'] },
        perms,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('wrong secret, malformed key, unknown prefix, revoked and expired keys all fail identically (null)', async () => {
    const k = await svc.create(
      ORG_A,
      USER,
      { name: 'fail-cases', scopes: ['project:read'] },
      perms,
    );
    const [prefix] = k.key.split(/_(?=[^_]*$)/);
    expect(await svc.authenticate(`${prefix}_${'A'.repeat(43)}`, '203.0.113.1')).toBeNull();
    expect(await svc.authenticate('garbage', '203.0.113.1')).toBeNull();
    expect(await svc.authenticate(`nzk_unknown1_${'A'.repeat(43)}`, '203.0.113.1')).toBeNull();
    expect(await svc.authenticate(k.key, '203.0.113.1')).not.toBeNull();
    expect(await svc.revoke(ORG_A, k.id)).toBe(true);
    expect(await svc.authenticate(k.key, '203.0.113.1')).toBeNull();
    const exp = await svc.create(
      ORG_A,
      USER,
      { name: 'exp', scopes: ['project:read'], expiresAt: new Date(Date.now() - 1000) },
      perms,
    );
    expect(await svc.authenticate(exp.key, '203.0.113.1')).toBeNull();
  });

  it('enforces the IP allow-list', async () => {
    const k = await svc.create(
      ORG_A,
      USER,
      { name: 'ip', scopes: ['project:read'], ipAllowList: ['203.0.113.0/24'] },
      perms,
    );
    expect(await svc.authenticate(k.key, '203.0.113.77')).not.toBeNull();
    expect(await svc.authenticate(k.key, '198.51.100.7')).toBeNull();
  });

  it("is tenant-scoped: org B cannot list, revoke or rotate org A's keys", async () => {
    const k = await svc.create(ORG_A, USER, { name: 'tenant', scopes: ['project:read'] }, perms);
    expect((await svc.list(ORG_B)).map((r: { id: string }) => r.id)).not.toContain(k.id);
    expect(await svc.revoke(ORG_B, k.id)).toBe(false);
    await expect(svc.rotate(ORG_B, k.id, USER)).rejects.toMatchObject({ code: 'not_found' });
    expect(await svc.authenticate(k.key, '203.0.113.1')).toMatchObject({ orgId: ORG_A }); // key still resolves to org A only
  });

  it('rotation issues a new key with the same scopes and revokes the old one', async () => {
    const old = await svc.create(
      ORG_A,
      USER,
      { name: 'rot', scopes: ['project:read', 'project:write'] },
      perms,
    );
    const next = await svc.rotate(ORG_A, old.id, USER);
    expect(next.key).not.toBe(old.key);
    expect(await svc.authenticate(old.key, '203.0.113.1')).toBeNull();
    expect(await svc.authenticate(next.key, '203.0.113.1')).toMatchObject({
      scopes: ['project:read', 'project:write'],
    });
  });

  it('records last use (throttled to once a minute)', async () => {
    const k = await svc.create(ORG_A, USER, { name: 'used', scopes: ['project:read'] }, perms);
    await svc.authenticate(k.key, '203.0.113.1');
    await new Promise((r) => setTimeout(r, 200));
    expect(
      (await env.sql(`SELECT last_used_at FROM identity.api_keys WHERE id=$1`, [k.id]))[0]!
        .last_used_at,
    ).not.toBeNull();
  });

  it('caches successful lookups briefly but revocation clears the cache immediately', async () => {
    const cached = new ApiKeyService(env.app, 30_000);
    const k = await cached.create(ORG_A, USER, { name: 'cache', scopes: ['project:read'] }, perms);
    expect(await cached.authenticate(k.key, '203.0.113.1')).not.toBeNull();
    await cached.revoke(ORG_A, k.id);
    expect(await cached.authenticate(k.key, '203.0.113.1')).toBeNull();
  });
});
