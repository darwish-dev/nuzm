import { describe, expect, it } from 'vitest';
import openapi from './openapi.public.json';
import postman from './postman.json';
import { REF, curlOf, nodeOf, opsOfTag, tagByName } from './index';

const INTERNAL = /\b(M\d{1,2}[A-Z]?|D-\d+|HG-\d+|ADR-\d+|FR-[A-Z]+-\d+|AC-M\d+|PA-\d+)\b|docs\/\d+/;

describe('generated API reference', () => {
  it('has only the public surface: no admin, SCIM, session-only or internal metering operations', () => {
    expect(REF.operations.length).toBeGreaterThan(200);
    for (const o of REF.operations) {
      expect(o.path.startsWith('/v1/')).toBe(true);
      // whole path segments: customer routes such as `.../wordpress/admin-resets` are fine, `/v1/admin/...` and `/scim/...` are not
      expect(o.path).not.toMatch(/\/(admin|scim)(\/|$)/);
    }
    const spec = JSON.stringify(openapi);
    expect(spec).not.toMatch(/sessionCookie|scimToken|sourceKey|x-nuzm-realm/);
    expect(Object.keys(openapi.components.securitySchemes)).toEqual(['apiKey']);
  });

  it('every operation has an id, a known tag, a valid method and an api-key-only security', () => {
    const ids = new Set<string>();
    for (const o of REF.operations) {
      expect(o.id).toBeTruthy();
      expect(ids.has(o.id), `duplicate ${o.id}`).toBe(false);
      ids.add(o.id);
      expect(tagByName(o.tag), o.id).toBeTruthy();
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(o.method);
    }
    for (const t of REF.tags) expect(opsOfTag(t.name).length).toBe(t.operations);
    for (const item of Object.values(openapi.paths) as Record<string, { security?: unknown }>[])
      for (const op of Object.values(item)) expect(op.security).toEqual([{ apiKey: [] }]);
  });

  it('the standalone OpenAPI file is self-contained: every $ref resolves', () => {
    const missing: string[] = [];
    const walk = (n: unknown) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const o = n as Record<string, unknown>;
      if (typeof o.$ref === 'string') {
        const found = o.$ref
          .replace(/^#\//, '')
          .split('/')
          .reduce<unknown>((a, p) => (a as Record<string, unknown> | undefined)?.[p], openapi);
        if (found === undefined) missing.push(o.$ref);
      }
      Object.values(o).forEach(walk);
    };
    walk(openapi);
    expect(missing).toEqual([]);
    expect(openapi.servers[0]!.url).toBe('{baseUrl}');
  });

  it('keeps the project’s internal references out of the public text', () => {
    for (const t of REF.tags) expect(t.description, t.name).not.toMatch(INTERNAL);
    for (const o of REF.operations) {
      expect(o.summary, o.id).not.toMatch(INTERNAL);
      expect(o.description, o.id).not.toMatch(INTERNAL);
    }
  });

  it('contains no credential-looking value', () => {
    const all = JSON.stringify([REF, openapi, postman]);
    expect(all).not.toMatch(
      /nzk_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|nzscim_[A-Za-z0-9]{16,}|-----BEGIN/,
    );
  });

  it('lists the stable error codes of the registry', () => {
    const codes = REF.errors.map((e) => e.code);
    for (const c of ['unauthenticated', 'forbidden', 'validation_failed', 'idempotency_key_reuse'])
      expect(codes).toContain(c);
    for (const e of REF.errors) expect(e.status).toBeGreaterThanOrEqual(400);
  });

  it('the Postman collection has one request per operation, with the variables', () => {
    const items = postman.item.flatMap((f) => f.item);
    expect(items.length).toBe(REF.operations.length);
    expect(postman.variable.map((v) => v.key)).toEqual(['baseUrl', 'apiKey']);
    expect(postman.auth.bearer[0]!.value).toBe('{{apiKey}}');
  });
});

describe('code samples', () => {
  const op = (id: string) => REF.operations.find((o) => o.id === id)!;

  it('a create call carries the key, an Idempotency-Key and a JSON body', () => {
    const c = curlOf(op('createApiKey'));
    expect(c).toContain('curl -X POST "$NUZM_API/v1/api-keys"');
    expect(c).toContain('Authorization: Bearer $NUZM_API_KEY');
    expect(c).toContain('Idempotency-Key: $(uuidgen)');
    expect(c).toContain('Content-Type: application/json');
    expect(c).toContain("-d '");
  });

  it('a read call is a plain GET and path placeholders are shown as <name>', () => {
    const g = REF.operations.find((o) => o.method === 'GET' && o.path.includes('{'))!;
    const c = curlOf(g);
    expect(c.startsWith('curl "')).toBe(true);
    expect(c).toMatch(/<[a-zA-Z]+>/);
    expect(c).not.toContain('{');
  });

  it('every Node.js sample is valid JavaScript', () => {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...a: string[]
    ) => unknown;
    for (const o of REF.operations) {
      expect(() => new AsyncFunction('API', 'KEY', 'etag', nodeOf(o)), o.id).not.toThrow();
    }
  });

  it('the endpoints used by the guides exist in the reference', () => {
    const has = (m: string, p: string) =>
      REF.operations.some((o) => o.method === m && o.path === p);
    expect(has('GET', '/v1/projects')).toBe(true);
    expect(has('POST', '/v1/webhook-endpoints')).toBe(true);
    expect(has('PATCH', '/v1/projects/{id}')).toBe(true);
    expect(has('GET', '/v1/operations/{id}')).toBe(true);
    expect(has('DELETE', '/v1/api-keys/{id}')).toBe(true);
  });
});
