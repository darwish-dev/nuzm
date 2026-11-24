import reference from './reference.json';

/** Types of `reference.json`, which `scripts/generate-api-docs.ts` writes from the OpenAPI contract. */
export interface Field {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  children?: Field[];
}
export interface ApiOp {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  success: null | { code: string; description: string; schema: string | null; fields: Field[] };
  errors: number[];
}
export interface ApiTag {
  name: string;
  title: string;
  description: string;
  operations: number;
}
export interface ApiErrorCode {
  code: string;
  status: number;
  title: string;
}
export interface ApiReference {
  title: string;
  specVersion: string;
  counts: { operations: number; tags: number };
  tags: ApiTag[];
  errors: ApiErrorCode[];
  operations: ApiOp[];
}

export const REF = reference as unknown as ApiReference;

export const tagByName = (name: string): ApiTag | undefined =>
  REF.tags.find((t) => t.name === name);
export const opsOfTag = (name: string): ApiOp[] => REF.operations.filter((o) => o.tag === name);

/** The URL of an operation with its placeholders written the way a person fills them in (`/v1/projects/<id>`). */
const urlOf = (op: ApiOp, style: 'shell' | 'js'): string => {
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, n: string) => `<${n}>`);
  const required = op.query.filter((q) => q.required).map((q) => `${q.name}=<${q.name}>`);
  const qs = required.length ? `?${required.join('&')}` : '';
  return style === 'shell' ? `$NUZM_API${path}${qs}` : `\${API}${path}${qs}`;
};

const headersOf = (op: ApiOp): string[] => {
  const h = ['Authorization: Bearer $NUZM_API_KEY'];
  if (op.idempotencyKey) h.push('Idempotency-Key: $(uuidgen)');
  if (op.ifMatch) h.push('If-Match: <etag>');
  if (op.body?.contentType.includes('json')) h.push('Content-Type: application/json');
  return h;
};

export function curlOf(op: ApiOp): string {
  const lines = [`curl${op.method === 'GET' ? '' : ` -X ${op.method}`} "${urlOf(op, 'shell')}"`];
  for (const h of headersOf(op)) lines.push(`  -H "${h}"`);
  if (op.body?.example !== undefined && op.body.example !== null)
    lines.push(`  -d '${JSON.stringify(op.body.example)}'`);
  return lines.join(' \\\n');
}

export function nodeOf(op: ApiOp): string {
  const headers = ['Authorization: `Bearer ${KEY}`'];
  if (op.idempotencyKey) headers.push("'Idempotency-Key': crypto.randomUUID()");
  if (op.ifMatch) headers.push("'If-Match': etag");
  if (op.body?.contentType.includes('json')) headers.push("'Content-Type': 'application/json'");
  const opts = [`  method: '${op.method}',`, `  headers: { ${headers.join(', ')} },`];
  if (op.body?.example !== undefined && op.body.example !== null)
    opts.push(`  body: JSON.stringify(${JSON.stringify(op.body.example)}),`);
  return `const res = await fetch(\`${urlOf(op, 'js')}\`, {\n${opts.join('\n')}\n});\nconst data = await res.json();`;
}
