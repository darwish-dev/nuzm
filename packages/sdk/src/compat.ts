/**
 * Backward-compatibility check between two OpenAPI documents (already parsed). It answers ONE question for the owner's review of a spec change request: could an existing client of
 * the BASE contract break against the HEAD contract? It is deliberately small and conservative, not a full OpenAPI differ:
 *  - BREAKING: a removed path, operation, `operationId`, response status, parameter or schema; a newly required parameter; a property removed; a type changed; an enum value removed;
 *    a new required property in a schema used by REQUESTS; a response property that was required becoming optional.
 *  - WARNING (additive, but a client with closed enums or exhaustive switches may need regeneration): an enum value added to a schema used by RESPONSES.
 *  - OK (not reported): new paths, operations, optional properties, enum values in REQUEST schemas, new required properties in RESPONSE schemas.
 * It follows `$ref`s inside `components.schemas` and the direction (request or response) in which each schema is used. A schema reachable in both directions is checked as both.
 */
export type Doc = {
  paths?: Record<string, Record<string, unknown>>;
  components?: { schemas?: Record<string, unknown> };
};
export interface Finding {
  level: 'BREAKING' | 'WARNING';
  where: string;
  what: string;
}
type Json = Record<string, unknown>;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const refName = (r: unknown): string | null =>
  isObj(r) && typeof r.$ref === 'string' ? r.$ref.replace('#/components/schemas/', '') : null;

/** Every schema name reachable from a schema (through $ref, properties, items, allOf/oneOf/anyOf, additionalProperties). */
function reach(doc: Doc, start: unknown, into: Set<string>): void {
  const schemas = doc.components?.schemas ?? {};
  const walk = (s: unknown): void => {
    if (!isObj(s)) return;
    const n = refName(s);
    if (n) {
      if (into.has(n)) return;
      into.add(n);
      walk(schemas[n]);
      return;
    }
    for (const k of ['allOf', 'oneOf', 'anyOf'])
      if (Array.isArray(s[k])) (s[k] as unknown[]).forEach(walk);
    if (isObj(s.properties)) Object.values(s.properties).forEach(walk);
    if (s.items) walk(s.items);
    if (isObj(s.additionalProperties)) walk(s.additionalProperties);
  };
  walk(start);
}
function usage(doc: Doc): { req: Set<string>; res: Set<string> } {
  const req = new Set<string>();
  const res = new Set<string>();
  for (const item of Object.values(doc.paths ?? {}))
    for (const [m, opRaw] of Object.entries(item)) {
      if (!METHODS.includes(m) || !isObj(opRaw)) continue;
      const body = (opRaw.requestBody as Json | undefined)?.content as Json | undefined;
      for (const c of Object.values(body ?? {})) reach(doc, (c as Json).schema, req);
      for (const r of Object.values((opRaw.responses as Json | undefined) ?? {}))
        for (const c of Object.values(((r as Json).content as Json | undefined) ?? {}))
          reach(doc, (c as Json).schema, res);
    }
  return { req, res };
}
const typesOf = (s: Json): string =>
  JSON.stringify(Array.isArray(s.type) ? [...(s.type as string[])].sort() : (s.type ?? null));

function compareSchema(
  name: string,
  a: unknown,
  b: unknown,
  dir: { req: boolean; res: boolean },
  out: Finding[],
  path = name,
): void {
  if (!isObj(a) || !isObj(b)) return;
  const ra = refName(a);
  const rb = refName(b);
  if (ra || rb) {
    if (ra !== rb)
      out.push({ level: 'BREAKING', where: path, what: `the reference changed (${ra} -> ${rb})` });
    return; // the referenced schema is compared on its own
  }
  if (typesOf(a) !== typesOf(b))
    out.push({
      level: 'BREAKING',
      where: path,
      what: `type changed ${typesOf(a)} -> ${typesOf(b)}`,
    });
  if (Array.isArray(a.enum)) {
    const eb = Array.isArray(b.enum) ? (b.enum as unknown[]) : null;
    const removed = (a.enum as unknown[]).filter((v) => !eb?.includes(v));
    if (!eb) out.push({ level: 'WARNING', where: path, what: 'the enum constraint was dropped' });
    else if (removed.length)
      out.push({
        level: 'BREAKING',
        where: path,
        what: `enum value(s) removed: ${removed.join(', ')}`,
      });
    const added = (eb ?? []).filter((v) => !(a.enum as unknown[]).includes(v));
    if (added.length && dir.res)
      out.push({
        level: 'WARNING',
        where: path,
        what: `enum value(s) added to a RESPONSE: ${added.join(', ')} (closed-enum clients may need regeneration)`,
      });
  } else if (Array.isArray(b.enum) && dir.req)
    out.push({ level: 'BREAKING', where: path, what: 'a new enum constraint on a request value' });
  const pa = isObj(a.properties) ? a.properties : {};
  const pb = isObj(b.properties) ? b.properties : {};
  for (const k of Object.keys(pa)) {
    if (!(k in pb))
      out.push({ level: 'BREAKING', where: `${path}.${k}`, what: 'property removed' });
    else compareSchema(name, pa[k], pb[k], dir, out, `${path}.${k}`);
  }
  const ra2 = new Set(Array.isArray(a.required) ? (a.required as string[]) : []);
  const rb2 = new Set(Array.isArray(b.required) ? (b.required as string[]) : []);
  for (const k of rb2)
    if (!ra2.has(k) && dir.req)
      out.push({
        level: 'BREAKING',
        where: `${path}.${k}`,
        what: 'newly required in a request schema',
      });
  for (const k of ra2)
    if (!rb2.has(k) && dir.res)
      out.push({
        level: 'BREAKING',
        where: `${path}.${k}`,
        what: 'was required in a response, now optional',
      });
  if (isObj(a.items) && isObj(b.items))
    compareSchema(name, a.items, b.items, dir, out, `${path}[]`);
}

export function compat(base: Doc, head: Doc): Finding[] {
  const out: Finding[] = [];
  for (const [p, item] of Object.entries(base.paths ?? {})) {
    const hItem = head.paths?.[p];
    for (const m of METHODS) {
      const a = item[m] as Json | undefined;
      if (!a) continue;
      const where = `${m.toUpperCase()} ${p}`;
      const b = hItem?.[m] as Json | undefined;
      if (!b) {
        out.push({ level: 'BREAKING', where, what: 'operation removed' });
        continue;
      }
      if (a.operationId !== b.operationId)
        out.push({
          level: 'BREAKING',
          where,
          what: `operationId changed (${a.operationId} -> ${b.operationId})`,
        });
      const ra = Object.keys((a.responses as Json | undefined) ?? {});
      const rb = Object.keys((b.responses as Json | undefined) ?? {});
      for (const s of ra)
        if (!rb.includes(s)) out.push({ level: 'BREAKING', where, what: `response ${s} removed` });
      const pk = (x: Json) =>
        new Map(
          ((x.parameters as Json[] | undefined) ?? [])
            .filter((q) => !q.$ref)
            .map((q) => [`${q.in}:${q.name}`, q] as const),
        );
      const pa = pk(a);
      const pb = pk(b);
      for (const k of pa.keys())
        if (!pb.has(k)) out.push({ level: 'BREAKING', where, what: `parameter ${k} removed` });
      for (const [k, q] of pb)
        if (!pa.has(k) && q.required === true)
          out.push({ level: 'BREAKING', where, what: `required parameter ${k} added` });
      const ba = !!(a.requestBody as Json | undefined);
      const bb = !!(b.requestBody as Json | undefined);
      if (!ba && bb && (b.requestBody as Json).required === true)
        out.push({ level: 'BREAKING', where, what: 'a required request body was added' });
    }
  }
  const ua = usage(base);
  const ub = usage(head);
  for (const [name, a] of Object.entries(base.components?.schemas ?? {})) {
    const b = head.components?.schemas?.[name];
    if (b === undefined) {
      out.push({ level: 'BREAKING', where: name, what: 'schema removed' });
      continue;
    }
    const dir = {
      req: ua.req.has(name) || ub.req.has(name),
      res: ua.res.has(name) || ub.res.has(name),
    };
    compareSchema(name, a, b, dir, out);
  }
  return out;
}
