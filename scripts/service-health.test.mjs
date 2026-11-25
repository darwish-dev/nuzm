import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { checkConsole, checkSignIn } from './service-health.mjs';

/** A scripted server: every test sets the answers per path. */
let origin;
let routes = {};
const server = createServer((req, res) => {
  const r = routes[new globalThis.URL(req.url, 'http://x').pathname] ?? { status: 404 };
  res.writeHead(r.status, r.headers ?? {});
  res.end(r.body ?? '');
});
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const page = (link) =>
  `<!doctype html><html lang="ar" dir="rtl"><body><input type="password"><a href="${link}">sso</a></body></html>`;
const WEB = { status: 200, body: page('/v1/auth/oidc/login?returnTo=%2Fconsole') };
const ADMIN = {
  status: 200,
  body: page('/v1/auth/oidc/login?realm=admin&amp;returnTo=x'),
};
const to = (location, status = 307) => ({ status, headers: { location } });

test('the customer console is healthy only when /login itself is the sign-in page', async () => {
  routes = { '/login': WEB };
  assert.equal(await checkConsole('web', origin), null);
  routes = { '/login': to('/ar/login'), '/ar/login': WEB };
  assert.match(await checkConsole('web', origin), /expected 200, answered 307/);
});

test('the admin console is healthy through exactly /login -> /ar/login -> 200', async () => {
  routes = { '/login': to('/ar/login'), '/ar/login': ADMIN };
  assert.equal(await checkConsole('admin', origin), null);
  routes = { '/login': ADMIN };
  assert.match(
    await checkConsole('admin', origin),
    /expected a redirect to \/ar\/login, answered 200/,
  );
});

test('a 307 is not enough: wrong destinations, other origins, loops and missing destinations fail', async () => {
  for (const [location, why] of [
    ['/error', /got \/error/],
    ['/ar/login?next=//evil.test', /got \/ar\/login\?next/],
    ['/en/login', /got \/en\/login/],
    ['http://evil.test/ar/login', /another origin/],
    ['//evil.test/ar/login', /another origin/],
    ['/login', /got \/login/],
  ]) {
    routes = { '/login': to(location), '/ar/login': ADMIN };
    assert.match(await checkConsole('admin', origin), why, location);
  }
  routes = { '/login': { status: 307 } };
  assert.match(await checkConsole('admin', origin), /without a destination/);
  routes = { '/login': to('/ar/login'), '/ar/login': to('/login') };
  assert.match(await checkConsole('admin', origin), /expected 200, answered 307/);
});

test('the final response must be 200 with the real sign-in page', async () => {
  for (const [answer, why] of [
    [{ status: 500, body: ADMIN.body }, /answered 500/],
    [{ status: 200, body: 'Application error' }, /not a console page/],
    [{ status: 200, body: '<html lang="ar"><body>maintenance</body></html>' }, /no password field/],
    [WEB, /no admin sign-in link/],
  ]) {
    routes = { '/login': to('/ar/login'), '/ar/login': answer };
    assert.match(await checkConsole('admin', origin), why);
  }
  assert.match(
    await checkConsole('web', 'http://127.0.0.1:1', { timeoutMs: 2000 }),
    /ECONNREFUSED|bad port/,
  );
});

test('sign-in: issuer, keys and the redirect the API makes are all checked', async () => {
  const web = 'http://127.0.0.1:1111';
  const ok = () => ({
    '/.well-known/openid-configuration': {
      status: 200,
      body: JSON.stringify({
        issuer: origin,
        jwks_uri: `${origin}/jwks`,
        authorization_endpoint: `${origin}/authorize`,
      }),
    },
    '/jwks': { status: 200, body: '{"keys":[{}]}' },
    '/v1/auth/oidc/login': to(
      `${origin}/authorize?redirect_uri=${encodeURIComponent(`${web}/v1/auth/oidc/callback`)}&state=s&code_challenge_method=S256`,
      302,
    ),
  });
  routes = ok();
  assert.equal(await checkSignIn(origin, origin, web), null);
  routes = { ...ok(), '/jwks': { status: 200, body: '{"keys":[]}' } };
  assert.match(await checkSignIn(origin, origin, web), /no signing key/);
  routes = { ...ok(), '/v1/auth/oidc/login': to('http://evil.test/authorize', 302) };
  assert.match(await checkSignIn(origin, origin, web), /went to http:\/\/evil\.test/);
  routes = ok();
  assert.match(await checkSignIn(origin, origin, 'http://127.0.0.1:2222'), /callback is/);
});
