/**
 * Developer-documentation generator. Reads `spec/openapi/openapi.yaml` (the contract, never edited here) and writes, under `apps/web/lib/api-docs/`:
 *   - reference.json        the compact reference the docs pages render (tags, operations, fields, samples)
 *   - openapi.public.json   a standalone OpenAPI 3.1 file with ONLY the public integration surface, for code generators and API clients
 *   - postman.json          a Postman collection of the same operations ({{baseUrl}} and {{apiKey}} variables)
 * Public surface = operations a customer API key can call (`apiKey` security) that are not in the admin realm. Admin, session-only, SCIM and internal metering
 * operations never appear. Nothing is invented: every text and field comes from the spec. `--check` fails when the committed files are stale (part of `pnpm verify`).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(__dirname, '..');
const outDir = join(root, 'apps', 'web', 'lib', 'api-docs');
const spec = parse(readFileSync(join(root, 'spec/openapi/openapi.yaml'), 'utf8')) as Spec;
const errorsYaml = parse(readFileSync(join(root, 'spec/openapi/errors.yaml'), 'utf8')) as {
  errors: Record<string, { status: number; title: string }>;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the OpenAPI document is untyped JSON; every access below is guarded */
type Spec = any;
type Obj = Record<string, any>;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function ref<T = Obj>(node: any): T {
  let n = node;
  let guard = 0;
  while (n && typeof n === 'object' && typeof n.$ref === 'string' && guard++ < 20) {
    const parts = (n.$ref as string).replace(/^#\//, '').split('/');
    n = parts.reduce((acc: any, p) => acc?.[p], spec);
  }
  return n as T;
}
const refName = (node: any): string | null =>
  node && typeof node.$ref === 'string' ? String(node.$ref).split('/').pop()! : null;

export interface Field {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  children?: Field[];
}

function typeOf(s: any): string {
  if (!s || typeof s !== 'object') return 'any';
  const name = refName(s);
  const r = ref(s) ?? {};
  if (r.enum) return `enum: ${r.enum.map((v: unknown) => String(v)).join(' | ')}`;
  const t = Array.isArray(r.type) ? r.type.filter((x: string) => x !== 'null').join(' | ') : r.type;
  if (t === 'array') return `array<${typeOf(r.items)}>`;
  if (r.oneOf || r.anyOf)
    return (r.oneOf ?? r.anyOf).map((x: unknown) => refName(x) ?? typeOf(x)).join(' | ');
  if (t === 'object' || r.properties) return name ?? 'object';
  const fmt = r.format ? ` (${r.format})` : '';
  return `${t ?? name ?? 'any'}${fmt}`;
}

function fieldsOf(schema: any, depth = 0, seen: string[] = []): Field[] {
  const name = refName(schema);
  if (name && seen.includes(name)) return [];
  const s = ref(schema);
  if (!s || typeof s !== 'object') return [];
  const merged: Obj = { ...(s.properties ?? {}) };
  let required: string[] = [...(s.required ?? [])];
  for (const part of s.allOf ?? []) {
    const p = ref(part) ?? {};
    Object.assign(merged, p.properties ?? {});
    required = required.concat(p.required ?? []);
  }
  if (s.type === 'array' && s.items) return fieldsOf(s.items, depth, name ? [...seen, name] : seen);
  const out: Field[] = [];
  for (const [k, v] of Object.entries(merged).slice(0, 60)) {
    const rv = ref(v) ?? {};
    const f: Field = {
      name: k,
      type: typeOf(v),
      required: required.includes(k),
    };
    const d = (rv.description ?? (v as Obj)?.description) as string | undefined;
    if (d) f.description = d;
    const inner = rv.type === 'array' ? rv.items : v;
    const innerObj = ref(inner) ?? {};
    if (depth < 2 && (innerObj.properties || innerObj.allOf)) {
      const kids = fieldsOf(inner, depth + 1, name ? [...seen, name] : seen);
      if (kids.length) f.children = kids;
    }
    out.push(f);
  }
  return out;
}

/** A sample value built from the schema (its own `example` when it has one), so a request can be copied and edited. */
function sample(schema: any, depth = 0, seen: string[] = []): unknown {
  const name = refName(schema);
  if (name && seen.includes(name)) return {};
  const s = ref(schema);
  if (!s || typeof s !== 'object') return null;
  if (s.example !== undefined) return s.example;
  if (s.enum) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== 'null') : s.type;
  if (t === 'array')
    return depth > 2 ? [] : [sample(s.items, depth + 1, name ? [...seen, name] : seen)];
  if (t === 'string') {
    if (s.format === 'uuid') return '0190b1e0-0000-7000-8000-000000000000';
    if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
    if (s.format === 'email') return 'name@example.com';
    if (s.format === 'uri') return 'https://example.com';
    return 'string';
  }
  if (t === 'integer' || t === 'number') return s.minimum ?? 1;
  if (t === 'boolean') return true;
  const props: Obj = { ...(s.properties ?? {}) };
  for (const part of s.allOf ?? []) Object.assign(props, ref(part)?.properties ?? {});
  if (depth > 2) return {};
  const o: Obj = {};
  const req = new Set<string>(s.required ?? []);
  for (const [k, v] of Object.entries(props).slice(0, 24)) {
    if (req.size === 0 || req.has(k)) o[k] = sample(v, depth + 1, name ? [...seen, name] : seen);
  }
  return o;
}

/**
 * The spec's descriptions carry the project's internal references (milestones, decisions, human gates, ADRs, docs paths). They mean nothing to an integrator and
 * some describe unfinished internal work, so the public documentation drops them. Only references are dropped, never the sentence around them.
 */
const INTERNAL =
  '(?:M\\d{1,2}[A-Z]?(?:-[A-Z]+)?|D-\\d+|HG-\\d+(?:-\\d+)?(?:\\.\\.\\d+)?|ADR-\\d+|S\\d{2}|FR-[A-Z]+-\\d+|AC-M\\d+|PA-\\d+|docs/\\d+[^ )]*)';
export function publicText(t: string): string {
  return t
    .replace(new RegExp(`\\s*\\([^()]*\\b${INTERNAL}\\b[^()]*\\)`, 'g'), '')
    .replace(new RegExp(`\\s*\\b${INTERNAL}\\b(?:[/,]\\s*${INTERNAL})*`, 'g'), '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const humanize = (tag: string): string =>
  tag
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
    .replace(/\bAi\b/, 'AI')
    .replace(/\bApi\b/, 'API');

interface OpOut {
  id: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  permission: string | null;
  orgScoped: boolean;
  idempotencyKey: boolean;
  ifMatch: boolean;
  path_params: Field[];
  query: Field[];
  body: null | {
    required: boolean;
    contentType: string;
    schema: string | null;
    fields: Field[];
    example: unknown;
  };
  success: { code: string; description: string; schema: string | null; fields: Field[] } | null;
  errors: number[];
}

const publicOps: { path: string; method: string; op: Obj }[] = [];
for (const [path, item] of Object.entries<Obj>(spec.paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (!op) continue;
    if ((op['x-nuzm-realm'] ?? 'customer') === 'admin') continue;
    const sec: Obj[] = op.security ?? spec.security ?? [];
    if (!sec.some((s) => 'apiKey' in s)) continue;
    publicOps.push({ path, method, op });
  }
}

const ops: OpOut[] = publicOps.map(({ path, method, op }) => {
  const params = (op.parameters ?? []).map((p: any) => ({
    raw: p,
    p: ref(p) as Obj,
    name: refName(p),
  }));
  const pf = (where: string): Field[] =>
    params
      .filter(
        (x: any) =>
          x.p.in === where &&
          !['OrgHeader', 'IdempotencyKey', 'IfMatch', 'ActingOrgHeader'].includes(x.name ?? ''),
      )
      .map((x: any) => ({
        name: x.p.name,
        type: typeOf(x.p.schema),
        required: x.p.required === true,
        ...(x.p.description ? { description: x.p.description } : {}),
      }));
  const bodyContent = op.requestBody?.content
    ? Object.entries<Obj>(op.requestBody.content)[0]
    : null;
  const body = bodyContent
    ? {
        required: op.requestBody.required === true,
        contentType: bodyContent[0],
        schema: refName(bodyContent[1].schema),
        fields: fieldsOf(bodyContent[1].schema),
        example: bodyContent[0].includes('json') ? sample(bodyContent[1].schema) : null,
      }
    : null;
  const codes = Object.keys(op.responses ?? {});
  const okCode = codes.find((c) => /^2/.test(c)) ?? null;
  let success: OpOut['success'] = null;
  if (okCode) {
    const r = ref(op.responses[okCode]) ?? {};
    const c = r.content ? Object.values<Obj>(r.content)[0] : null;
    success = {
      code: okCode,
      description: r.description ?? '',
      schema: c ? refName(c.schema) : null,
      fields: c ? fieldsOf(c.schema) : [],
    };
  }
  return {
    id: op.operationId as string,
    method: method.toUpperCase(),
    path,
    tag: op.tags[0] as string,
    summary: publicText((op.summary ?? '') as string),
    description: publicText((op.description ?? '') as string),
    permission: (op['x-nuzm-permission'] ?? null) as string | null,
    orgScoped: op['x-nuzm-org-scoped'] === true,
    idempotencyKey: params.some((x: any) => x.name === 'IdempotencyKey'),
    ifMatch: params.some((x: any) => x.name === 'IfMatch'),
    path_params: pf('path'),
    query: pf('query'),
    body,
    success,
    errors: codes.filter((c) => /^[45]/.test(c)).map(Number),
  };
});

const tagDesc = new Map<string, string>(
  (spec.tags ?? []).map((t: Obj) => [t.name, publicText(t.description ?? '')]),
);
const tagNames = [...new Set(ops.map((o) => o.tag))].sort();
const reference = {
  title: 'Nuzm Platform API',
  specVersion: spec.info?.version ?? '0.0.0',
  generatedFrom: 'spec/openapi/openapi.yaml',
  counts: { operations: ops.length, tags: tagNames.length },
  tags: tagNames.map((name) => ({
    name,
    title: humanize(name),
    description: tagDesc.get(name) ?? '',
    operations: ops.filter((o) => o.tag === name).length,
  })),
  errors: Object.entries(errorsYaml.errors)
    .map(([code, e]) => ({ code, status: e.status, title: e.title }))
    .sort((a, b) => a.status - b.status || a.code.localeCompare(b.code)),
  operations: ops,
};

/* ---- standalone OpenAPI: public operations plus the components they reach ---- */
const keep = new Set<string>();
const queue: any[] = [];
const collect = (node: any) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(collect);
  if (typeof node.$ref === 'string') {
    const r = node.$ref as string;
    if (!keep.has(r)) {
      keep.add(r);
      queue.push(
        r
          .replace(/^#\//, '')
          .split('/')
          .reduce((a: any, p) => a?.[p], spec),
      );
    }
    return;
  }
  Object.values(node).forEach(collect);
};
const paths: Obj = {};
for (const { path, method, op } of publicOps) {
  const clean: Obj = { ...op };
  delete clean['x-nuzm-realm'];
  clean.security = [{ apiKey: [] }];
  (paths[path] ??= {})[method] = clean;
  collect(clean);
}
while (queue.length) collect(queue.pop());
const components: Obj = { securitySchemes: { apiKey: spec.components.securitySchemes.apiKey } };
for (const r of keep) {
  const [, kind, name] = r.replace(/^#\//, '').split('/');
  if (kind && name) ((components[kind] ??= {}) as Obj)[name] = spec.components[kind][name];
}
const openapi = {
  openapi: spec.openapi,
  info: {
    title: 'Nuzm Platform API',
    version: spec.info?.version ?? '0.0.0',
    description:
      'The public integration surface of the Nuzm platform: the operations an organization API key (`Authorization: Bearer nzk_…`) can call. Generated from the platform contract; admin, session-only, SCIM and internal operations are not included.',
  },
  servers: [
    {
      url: '{baseUrl}',
      description: 'Your Nuzm API host',
      variables: {
        baseUrl: {
          default: 'https://api.example.com',
          description: 'The API origin of your Nuzm deployment',
        },
      },
    },
  ],
  tags: tagNames.map((n) => ({ name: n, description: tagDesc.get(n) ?? '' })),
  security: [{ apiKey: [] }],
  paths,
  components,
};

/* ---- Postman collection ---- */
const postman = {
  info: {
    name: 'Nuzm Platform API',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Public integration surface. Set the baseUrl and apiKey collection variables.',
  },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{apiKey}}', type: 'string' }] },
  variable: [
    { key: 'baseUrl', value: 'https://api.example.com' },
    { key: 'apiKey', value: '' },
  ],
  item: tagNames.map((tag) => ({
    name: humanize(tag),
    item: ops
      .filter((o) => o.tag === tag)
      .map((o) => {
        const header: { key: string; value: string }[] = [];
        if (o.idempotencyKey) header.push({ key: 'Idempotency-Key', value: '{{$guid}}' });
        if (o.body?.contentType.includes('json'))
          header.push({ key: 'Content-Type', value: 'application/json' });
        const segs = o.path
          .replace(/^\//, '')
          .split('/')
          .map((s) => s.replace(/^\{(.+)\}$/, ':$1'));
        return {
          name: `${o.summary || o.id}`,
          request: {
            method: o.method,
            header,
            url: {
              raw: `{{baseUrl}}/${segs.join('/')}`,
              host: ['{{baseUrl}}'],
              path: segs,
              query: o.query.map((q) => ({ key: q.name, value: '', disabled: !q.required })),
              variable: o.path_params.map((p) => ({ key: p.name, value: '' })),
            },
            description: o.description,
            ...(o.body?.example
              ? { body: { mode: 'raw', raw: JSON.stringify(o.body.example, null, 2) } }
              : {}),
          },
        };
      }),
  })),
};

const files: Record<string, string> = {
  'reference.json': JSON.stringify(reference),
  'openapi.public.json': JSON.stringify(openapi),
  'postman.json': JSON.stringify(postman),
};

if (process.argv.includes('--check')) {
  const stale = Object.entries(files).filter(
    ([name, body]) =>
      !existsSync(join(outDir, name)) || readFileSync(join(outDir, name), 'utf8') !== body,
  );
  if (stale.length) {
    console.error(
      `api docs are stale: ${stale.map(([n]) => n).join(', ')} (run pnpm docs:generate)`,
    );
    process.exit(1);
  }
  console.log(`api docs are up to date (${ops.length} operations, ${tagNames.length} tags)`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(outDir, name), body);
  console.log(
    `wrote ${Object.keys(files).length} files to ${outDir} (${ops.length} operations, ${tagNames.length} tags)`,
  );
}
