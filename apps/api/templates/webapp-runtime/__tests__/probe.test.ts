import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REQUIRED_CHECKS, runProbe } from '../probe/suite.ts';
import { newApp } from './fixture.ts';

const show = (r: { checks: { id: string; status: string; detail: string }[] }) =>
  JSON.stringify(r.checks.filter((c) => c.status !== 'pass'));

test('the probe suite passes every required check against a single-tenant app (in-process, MemoryStore)', async () => {
  const a = newApp();
  const r = await runProbe(a.transport, a.ctx);
  assert.equal(r.ok, true, show(r));
  assert.deepEqual(r.requiredNotPassed, []);
  for (const id of REQUIRED_CHECKS)
    assert.equal(r.checks.find((c) => c.id === id)?.status, 'pass', id);
  assert.equal(r.checks.find((c) => c.id === 'signup')?.status, 'skipped'); // sign-up is off: skipped is explicit, and signup is not a required check
  assert.equal(r.tenancy, 'single');
});

test('the probe suite passes with public sign-up on', async () => {
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  const r = await runProbe(a.transport, a.ctx);
  assert.equal(r.ok, true, show(r));
  assert.equal(r.checks.find((c) => c.id === 'signup')?.status, 'pass');
});

test('the probe suite passes a multi-tenant app with two organisations', async () => {
  const a = newApp({ signupRole: 'admin', tenancy: 'multi' });
  const r = await runProbe(a.transport, a.ctx);
  assert.equal(r.ok, true, show(r));
  assert.match(
    r.checks.find((c) => c.id === 'cross-user-isolation')?.detail ?? '',
    /two organisations/,
  );
});

test('the probe FAILS when an authenticated route is left open', async () => {
  const a = newApp();
  const broken = {
    async request(m: string, p: string, o?: Parameters<typeof a.transport.request>[2]) {
      if (p.endsWith('/auth/me') && !o?.token)
        return { status: 200, headers: {}, body: { user: {} }, text: '{}' };
      return a.transport.request(m, p, o);
    },
  };
  const r = await runProbe(broken, a.ctx);
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.id === 'unauthenticated-rejected')?.status, 'fail');
});

test('the probe FAILS when logout does not revoke and when the security headers are missing', async () => {
  const a = newApp();
  // 1. logout that does nothing
  const noRevoke = {
    async request(m: string, p: string, o?: Parameters<typeof a.transport.request>[2]) {
      if (p.endsWith('/auth/logout'))
        return { status: 204, headers: {}, body: undefined, text: '' };
      return a.transport.request(m, p, o);
    },
  };
  assert.equal(
    (await runProbe(noRevoke, a.ctx)).checks.find((c) => c.id === 'logout-revokes')?.status,
    'fail',
  );
  // 2. responses without the security headers
  const noHeaders = {
    async request(m: string, p: string, o?: Parameters<typeof a.transport.request>[2]) {
      const r = await a.transport.request(m, p, o);
      return { ...r, headers: {} };
    },
  };
  const h = await runProbe(noHeaders, a.ctx);
  assert.equal(h.checks.find((c) => c.id === 'security-headers')?.status, 'fail');
  assert.equal(h.ok, false);
});

test('a skipped required check is not a pass: an app with no scope-limited role cannot claim cross-user isolation', async () => {
  const a = newApp();
  a.meta.roles['rep']!.scope = 'all';
  const r = await runProbe(a.transport, { ...a.ctx, meta: a.meta as never });
  assert.equal(r.checks.find((c) => c.id === 'cross-user-isolation')?.status, 'skipped');
  assert.ok(r.requiredNotPassed.includes('cross-user-isolation'));
  assert.equal(r.ok, false);
});

test('the report never contains a password, a token or a hash', async () => {
  const a = newApp({ signupRole: 'rep', tenancy: 'single' });
  const r = await runProbe(a.transport, a.ctx);
  const text = JSON.stringify(r);
  assert.ok(!text.includes('s1$'));
  assert.ok(!text.includes(a.ctx.password));
  assert.ok(!/eyJ|\.[A-Za-z0-9_-]{40,}/.test(text.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '')));
});
