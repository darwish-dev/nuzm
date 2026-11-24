/**
 * The allow-list of the SIMULATED node's commands (a test double; the product allow-list is `hestia/commands.ts`). A command that is not in COMMANDS does not exist. Arguments are validated against a small JSON-Schema
 * subset with `additionalProperties:false`; there is NO free-form path, shell, flag or command member in any schema.
 */
import { RUNTIME_ID } from '../../ports';

export interface Schema {
  type: 'object' | 'string' | 'integer' | 'boolean' | 'array';
  properties?: Record<string, Schema>;
  required?: string[];
  pattern?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  items?: Schema;
  maxItems?: number;
}

export const SITE_NAME = '^s-[a-z0-9]{12,40}$';
export const DOMAIN_RE = '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$';
const VAULT_REF = '^vault://(?!.*\\.\\.)(?!.*//)[A-Za-z0-9/_.-]{3,200}$';
const BACKUP_ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const SHA256 = '^[0-9a-f]{64}$';

const siteName: Schema = { type: 'string', pattern: SITE_NAME };
const domain: Schema = { type: 'string', pattern: DOMAIN_RE };
const limits: Schema = {
  type: 'object',
  required: ['diskMb', 'inodes', 'maxProcesses', 'memoryMb', 'bandwidthGbMonth'],
  properties: {
    diskMb: { type: 'integer', minimum: 1, maximum: 10_000_000 },
    inodes: { type: 'integer', minimum: 1000, maximum: 100_000_000 },
    maxProcesses: { type: 'integer', minimum: 5, maximum: 10_000 },
    memoryMb: { type: 'integer', minimum: 64, maximum: 262_144 },
    bandwidthGbMonth: { type: 'integer', minimum: 0, maximum: 1_000_000 },
  },
};
const noArgs: Schema = { type: 'object', properties: {} };
const bySite: Schema = { type: 'object', required: ['site'], properties: { site: siteName } };

export interface CommandDef {
  id: string;
  schema: Schema;
  /** Mutating commands go through the replay/idempotency ledger; reads are re-executable. */
  mutating: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
}

const def = (id: string, schema: Schema, mutating: boolean, timeoutMs = 120_000): CommandDef => ({
  id,
  schema,
  mutating,
  timeoutMs,
  maxOutputBytes: 64 * 1024,
});

export const COMMANDS: Record<string, CommandDef> = Object.fromEntries(
  [
    def('inventory', noArgs, false, 30_000),
    def('probe', noArgs, false, 30_000),
    def(
      'site.create',
      {
        type: 'object',
        required: ['site', 'runtime', 'domain', 'limits', 'credentialsRef', 'backupKeyRef'],
        properties: {
          site: siteName,
          runtime: { type: 'string', pattern: RUNTIME_ID.source },
          domain,
          limits,
          credentialsRef: { type: 'string', pattern: VAULT_REF },
          backupKeyRef: { type: 'string', pattern: VAULT_REF },
        },
      },
      true,
    ),
    def('site.find', bySite, false),
    def(
      'site.update',
      {
        type: 'object',
        required: ['site'],
        properties: {
          site: siteName,
          limits,
          runtime: { type: 'string', pattern: RUNTIME_ID.source },
        },
      },
      true,
    ),
    def('site.suspend', bySite, true),
    def('site.resume', bySite, true),
    def('site.delete', bySite, true),
    def('site.wipe.verify', bySite, false),
    def(
      'domain.bind',
      { type: 'object', required: ['site', 'domain'], properties: { site: siteName, domain } },
      true,
    ),
    def(
      'domain.unbind',
      { type: 'object', required: ['site', 'domain'], properties: { site: siteName, domain } },
      true,
    ),
    def(
      'cert.issue',
      {
        type: 'object',
        required: ['site', 'domains'],
        properties: { site: siteName, domains: { type: 'array', items: domain, maxItems: 20 } },
      },
      true,
    ),
    def(
      'cert.install',
      {
        type: 'object',
        required: ['site', 'domains', 'certRef'],
        properties: {
          site: siteName,
          domains: { type: 'array', items: domain, maxItems: 20 },
          certRef: { type: 'string', pattern: VAULT_REF },
        },
      },
      true,
    ),
    def(
      'backup.create',
      {
        type: 'object',
        required: ['site', 'backupId'],
        properties: { site: siteName, backupId: { type: 'string', pattern: BACKUP_ID } },
      },
      true,
    ),
    def(
      'backup.restore',
      {
        type: 'object',
        required: ['site', 'backupId', 'checksum'],
        properties: {
          site: siteName,
          backupId: { type: 'string', pattern: BACKUP_ID },
          checksum: { type: 'string', pattern: SHA256 },
        },
      },
      true,
    ),
    def('usage.report', bySite, false),
    def(
      'quota.apply',
      { type: 'object', required: ['site', 'limits'], properties: { site: siteName, limits } },
      true,
    ),
    def(
      'db.binding.apply',
      { type: 'object', required: ['site'], properties: { site: siteName } },
      true,
    ),
  ].map((d) => [d.id, d]),
);

export function validateArgs(schema: Schema, value: unknown, path = 'args'): string | null {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return `${path}: must be an object`;
    const o = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const k of Object.keys(o)) if (!(k in props)) return `${path}.${k}: unknown member`;
    for (const r of schema.required ?? []) if (!(r in o)) return `${path}.${r}: required`;
    for (const [k, s] of Object.entries(props))
      if (k in o) {
        const e = validateArgs(s, o[k], `${path}.${k}`);
        if (e) return e;
      }
    return null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path}: must be an array`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `${path}: too many items`;
    for (let i = 0; i < value.length; i++) {
      const e = validateArgs(schema.items!, value[i], `${path}[${i}]`);
      if (e) return e;
    }
    return null;
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path}: must be a string`;
    if (value.length > (schema.maxLength ?? 500)) return `${path}: too long`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value))
      return `${path}: does not match the allowed pattern`;
    if (schema.enum && !schema.enum.includes(value)) return `${path}: not an allowed value`;
    return null;
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `${path}: must be an integer`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path}: below minimum`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path}: above maximum`;
    return null;
  }
  if (schema.type === 'boolean')
    return typeof value === 'boolean' ? null : `${path}: must be a boolean`;
  return `${path}: unsupported schema`;
}
