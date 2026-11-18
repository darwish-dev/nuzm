/** A deliberately small JSON-schema subset (no dependency): enough to validate agent artifacts and request bodies. Returns messages, never throws. */
export interface Schema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';
  enum?: readonly unknown[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  oneOf?: readonly Schema[];
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

export function validate(schema: Schema, value: unknown, path = '$'): string[] {
  const errs: string[] = [];
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validate(s, value, path).length === 0).length;
    if (hits !== 1) errs.push(`${path}: must match exactly one alternative (matched ${hits})`);
    return errs;
  }
  if (schema.type) {
    const t = typeOf(value);
    const ok =
      schema.type === t ||
      (schema.type === 'number' && (t === 'integer' || t === 'number')) ||
      (schema.type === 'integer' && t === 'integer');
    if (!ok) return [`${path}: expected ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value))
    errs.push(`${path}: must be one of ${schema.enum.map(String).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errs.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))
      errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errs.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errs.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.uniqueItems && new Set(value.map((x) => JSON.stringify(x))).size !== value.length)
      errs.push(`${path}: items must be unique`);
    if (schema.items)
      value.forEach((x, i) => errs.push(...validate(schema.items!, x, `${path}[${i}]`)));
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? [])
      if (!(k in o) || o[k] === undefined) errs.push(`${path}.${k}: is required`);
    for (const [k, s] of Object.entries(schema.properties ?? {}))
      if (k in o && o[k] !== undefined) errs.push(...validate(s, o[k], `${path}.${k}`));
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of Object.keys(o)) {
        if (o[k] === undefined || (schema.properties && k in schema.properties)) continue;
        if (schema.additionalProperties === false) errs.push(`${path}.${k}: is not allowed`);
        else errs.push(...validate(schema.additionalProperties, o[k], `${path}.${k}`));
      }
    }
  }
  return errs;
}
