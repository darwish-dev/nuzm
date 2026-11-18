/**
 * A deliberately small JSON-Schema subset validator (no dependency): enough for the versioned site model, the agent artifacts and the editor ops.
 * Supported keywords: type (string|number|integer|boolean|object|array|null, or a list), enum, const, properties, required, additionalProperties (false|schema),
 * items, minItems, maxItems, minLength, maxLength, pattern, minimum, maximum, oneOf, anyOf, patternProperties-less `propertyNames` NOT supported.
 * An unknown keyword is IGNORED, so every schema in this repo is written only with the keywords above (tests enforce parse-ability, not exotic keywords).
 */
export type Schema = {
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  oneOf?: readonly Schema[];
  anyOf?: readonly Schema[];
  description?: string;
  $id?: string;
  title?: string;
};

export interface SchemaError {
  path: string;
  message: string;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const typeOk = (t: string, v: unknown): boolean => {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
};

export function validateSchema(
  schema: Schema,
  value: unknown,
  path = '$',
  out: SchemaError[] = [],
): SchemaError[] {
  const err = (message: string) => out.push({ path, message });
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeOk(t, value))) {
      err(`expected ${types.join('|')}, got ${typeOf(value)}`);
      return out;
    }
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    err('does not match the required constant');
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    err(`must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      err(`shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      err(`longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value))
      err(`does not match ${schema.pattern}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) err(`below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) err(`above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      err(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      err(`more than ${schema.maxItems} items`);
    if (schema.items)
      value.forEach((v, i) => validateSchema(schema.items!, v, `${path}[${i}]`, out));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? [])
      if (!(k in o)) out.push({ path: `${path}.${k}`, message: 'is required' });
    for (const [k, s] of Object.entries(schema.properties ?? {}))
      if (k in o) validateSchema(s, o[k], `${path}.${k}`, out);
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      for (const k of Object.keys(o)) {
        if (schema.properties && k in schema.properties) continue;
        if (schema.additionalProperties === false)
          out.push({ path: `${path}.${k}`, message: 'is not allowed' });
        else validateSchema(schema.additionalProperties, o[k], `${path}.${k}`, out);
      }
    }
  }
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validateSchema(s, value, path, []).length === 0).length;
    if (hits !== 1) err(`must match exactly one alternative (matched ${hits})`);
  }
  if (schema.anyOf && !schema.anyOf.some((s) => validateSchema(s, value, path, []).length === 0))
    err('must match at least one alternative');
  return out;
}
export const isValid = (schema: Schema, value: unknown) =>
  validateSchema(schema, value).length === 0;
