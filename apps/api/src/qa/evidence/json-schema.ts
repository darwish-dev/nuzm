/**
 * P3-S08: a small, dependency-free JSON Schema validator for the Phase 3 evidence schemas (`docs/phase3/EVIDENCE/schemas/*.schema.json`).
 *
 * It implements ONLY the keyword subset those schemas use, so any standard validator (ajv, draft 2020-12) must agree with it on the same files:
 *   type, enum, const, required, properties, minProperties, additionalProperties (boolean | schema), patternProperties, items, minItems, maxItems, uniqueItems,
 *   minLength, maxLength, pattern, minimum, maximum, allOf, anyOf, oneOf, not, if/then/else, $ref to `#/$defs/<name>` or to another loaded schema by `$id`.
 * A keyword it does not implement makes `validate` THROW (never silently pass): an unknown keyword in a schema is a bug in the schema, not a free pass.
 */
export type Schema = { [k: string]: unknown };
export interface SchemaProblem {
  /** JSON pointer of the offending value, e.g. `/outputs/0/sha256` */
  path: string;
  message: string;
}

const KNOWN = new Set([
  '$schema',
  '$id',
  '$defs',
  '$comment',
  '$ref',
  'title',
  'description',
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'patternProperties',
  'items',
  'minItems',
  'maxItems',
  'minProperties',
  'uniqueItems',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'default',
  'examples',
]);

const typeOf = (v: unknown): string =>
  v === null
    ? 'null'
    : Array.isArray(v)
      ? 'array'
      : typeof v === 'number'
        ? Number.isInteger(v)
          ? 'integer'
          : 'number'
        : typeof v;
const isType = (v: unknown, t: string): boolean => {
  const a = typeOf(v);
  return a === t || (t === 'number' && a === 'integer');
};
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const esc = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

export class SchemaSet {
  private readonly byId = new Map<string, Schema>();
  constructor(schemas: readonly Schema[]) {
    for (const s of schemas) {
      const id = s.$id;
      if (typeof id !== 'string' || id.length === 0)
        throw new Error('every schema in a SchemaSet needs a string $id');
      this.byId.set(id, s);
    }
  }
  get(id: string): Schema {
    const s = this.byId.get(id);
    if (!s) throw new Error(`unknown schema ${id}`);
    return s;
  }
  ids(): string[] {
    return [...this.byId.keys()];
  }

  validate(schemaId: string, value: unknown): SchemaProblem[] {
    const root = this.get(schemaId);
    const out: SchemaProblem[] = [];
    this.check(root, root, value, '', out);
    return out;
  }

  private resolve(ref: string, root: Schema): { schema: Schema; root: Schema } {
    const [base, frag] = ref.split('#') as [string, string | undefined];
    const target = base === '' ? root : this.get(base);
    if (!frag) return { schema: target, root: target };
    if (!frag.startsWith('/$defs/')) throw new Error(`unsupported $ref ${ref}`);
    const name = frag.slice('/$defs/'.length);
    const defs = (target.$defs ?? {}) as Record<string, Schema>;
    const d = defs[name];
    if (!d) throw new Error(`unresolved $ref ${ref}`);
    return { schema: d, root: target };
  }

  private check(s: Schema, root: Schema, v: unknown, path: string, out: SchemaProblem[]): void {
    for (const k of Object.keys(s))
      if (!KNOWN.has(k)) throw new Error(`schema keyword not supported by the validator: ${k}`);
    const at = path === '' ? '/' : path;
    const bad = (message: string) => out.push({ path: at, message });

    if (typeof s.$ref === 'string') {
      const r = this.resolve(s.$ref, root);
      this.check(r.schema, r.root, v, path, out);
    }
    if (s.type !== undefined) {
      const ts = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      if (!ts.some((t) => isType(v, t))) {
        bad(`expected ${ts.join(' or ')}, got ${typeOf(v)}`);
        return; // the keywords below assume the type
      }
    }
    if (s.const !== undefined && !deepEqual(v, s.const))
      bad(`must equal ${JSON.stringify(s.const)}`);
    if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, v)))
      bad(`must be one of ${JSON.stringify(s.enum)}`);

    if (typeof v === 'string') {
      if (typeof s.minLength === 'number' && v.length < s.minLength)
        bad(`shorter than ${s.minLength}`);
      if (typeof s.maxLength === 'number' && v.length > s.maxLength)
        bad(`longer than ${s.maxLength}`);
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v))
        bad(`does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (typeof s.minimum === 'number' && v < s.minimum) bad(`below ${s.minimum}`);
      if (typeof s.maximum === 'number' && v > s.maximum) bad(`above ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof s.minItems === 'number' && v.length < s.minItems)
        bad(`fewer than ${s.minItems} items`);
      if (typeof s.maxItems === 'number' && v.length > s.maxItems)
        bad(`more than ${s.maxItems} items`);
      if (s.uniqueItems === true) {
        const seen = new Set(v.map((x) => JSON.stringify(x)));
        if (seen.size !== v.length) bad('items must be unique');
      }
      if (s.items !== undefined)
        v.forEach((x, i) => this.check(s.items as Schema, root, x, `${path}/${i}`, out));
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (typeof s.minProperties === 'number' && Object.keys(o).length < s.minProperties)
        bad(`fewer than ${s.minProperties} properties`);
      for (const r of (s.required as string[] | undefined) ?? [])
        if (!Object.prototype.hasOwnProperty.call(o, r)) bad(`missing required property "${r}"`);
      const props = (s.properties ?? {}) as Record<string, Schema>;
      const pats = Object.entries((s.patternProperties ?? {}) as Record<string, Schema>).map(
        ([p, sc]) => [new RegExp(p, 'u'), sc] as const,
      );
      for (const [k, val] of Object.entries(o)) {
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          matched = true;
          this.check(props[k]!, root, val, `${path}/${esc(k)}`, out);
        }
        for (const [re, sc] of pats)
          if (re.test(k)) {
            matched = true;
            this.check(sc, root, val, `${path}/${esc(k)}`, out);
          }
        if (!matched) {
          if (s.additionalProperties === false)
            out.push({ path: `${path}/${esc(k)}`, message: 'property is not allowed' });
          else if (typeof s.additionalProperties === 'object' && s.additionalProperties !== null)
            this.check(s.additionalProperties as Schema, root, val, `${path}/${esc(k)}`, out);
        }
      }
    }
    for (const sub of (s.allOf as Schema[] | undefined) ?? []) this.check(sub, root, v, path, out);
    if (Array.isArray(s.anyOf)) {
      const ok = (s.anyOf as Schema[]).some((sub) => {
        const tmp: SchemaProblem[] = [];
        this.check(sub, root, v, path, tmp);
        return tmp.length === 0;
      });
      if (!ok) bad('must match at least one of the allowed shapes');
    }
    if (Array.isArray(s.oneOf)) {
      const n = (s.oneOf as Schema[]).filter((sub) => {
        const tmp: SchemaProblem[] = [];
        this.check(sub, root, v, path, tmp);
        return tmp.length === 0;
      }).length;
      if (n !== 1) bad(`must match exactly one of the allowed shapes (matched ${n})`);
    }
    if (s.not !== undefined) {
      const tmp: SchemaProblem[] = [];
      this.check(s.not as Schema, root, v, path, tmp);
      if (tmp.length === 0) bad('matches a shape that is not allowed');
    }
    if (s.if !== undefined) {
      const tmp: SchemaProblem[] = [];
      this.check(s.if as Schema, root, v, path, tmp);
      if (tmp.length === 0) {
        if (s.then !== undefined) this.check(s.then as Schema, root, v, path, out);
      } else if (s.else !== undefined) this.check(s.else as Schema, root, v, path, out);
    }
  }
}
