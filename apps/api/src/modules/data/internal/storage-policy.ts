import { createHash } from 'node:crypto';
import type { BucketPolicyDoc, LifecycleRule } from '@nuzm/adapter-data';
import { ProblemException } from '../../../common/errors';

/** Signed URL limits (M08 S34 task 2): maximum TTL proposal 7 days, default 15 minutes. */
export const SIGNED_URL_MAX_TTL_SECONDS = 7 * 86_400;
export const SIGNED_URL_DEFAULT_TTL_SECONDS = 900;
export const SIGNED_URL_METHODS = ['GET', 'PUT', 'HEAD', 'DELETE'] as const;
const ACTIONS = ['read', 'write', 'delete', 'list'] as const;
const CORS_METHODS = ['GET', 'PUT', 'HEAD'] as const;

/** Bucket names are `nz-<orgShort>-<name>`: the namespace is derived from the organization, never from input. */
export const orgShort = (orgId: string): string =>
  createHash('sha256').update(`nuzm-bucket-ns|${orgId}`).digest('hex').slice(0, 10);
export const bucketGlobalName = (orgId: string, name: string): string =>
  `nz-${orgShort(orgId)}-${name}`;
/** Customer names cannot start with the reserved prefixes of the namespace (`nz-`) or of the platform's own buckets (`sys-`). */
export const BUCKET_NAME = /^(?!nz-|sys-)[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const bad = (m: string, errors?: unknown[]) => new ProblemException('policy_invalid', m, errors);
const KEY = /^[^\u0000-\u001f\u007f]{0,200}$/;

/**
 * The accepted policy subset (deny-by-default): version 1, access private|public-read, allow-only statements for the bucket's own credentials, optional
 * CORS. Anything else — unknown keys, deny statements, other principals, wildcards in the prefix, an `Action: *` — is refused: Nuzm never passes a raw
 * vendor policy through (the adapter translates this document). Returns the canonical document.
 */
export function parsePolicy(raw: unknown): BucketPolicyDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw bad('policy must be an object');
  const p = raw as Record<string, unknown>;
  const extra = Object.keys(p).filter(
    (k) => !['version', 'access', 'statements', 'cors'].includes(k),
  );
  if (extra.length) throw bad(`unknown policy field: ${extra[0]}`);
  if (p.version !== 1) throw bad('policy.version must be 1');
  if (p.access !== 'private' && p.access !== 'public-read')
    throw bad('policy.access must be private or public-read');
  const st = p.statements ?? [];
  if (!Array.isArray(st) || st.length > 20)
    throw bad('policy.statements must be a list of at most 20 statements');
  const statements = st.map((s, i) => {
    if (typeof s !== 'object' || s === null || Array.isArray(s))
      throw bad(`statement ${i} must be an object`);
    const x = s as Record<string, unknown>;
    if (Object.keys(x).some((k) => !['effect', 'actions', 'prefix', 'principal'].includes(k)))
      throw bad(`statement ${i}: unknown field`);
    if (x.effect !== 'allow')
      throw bad(`statement ${i}: only allow statements exist (deny-by-default)`);
    if (x.principal !== 'bucket-credentials')
      throw bad(`statement ${i}: the only principal is bucket-credentials`);
    if (
      !Array.isArray(x.actions) ||
      x.actions.length < 1 ||
      x.actions.some((a) => !(ACTIONS as readonly unknown[]).includes(a))
    )
      throw bad(`statement ${i}: actions must be a non-empty subset of ${ACTIONS.join(', ')}`);
    const prefix = x.prefix ?? '';
    if (
      typeof prefix !== 'string' ||
      !KEY.test(prefix) ||
      /[*?]|\.\./.test(prefix) ||
      prefix.startsWith('/')
    )
      throw bad(`statement ${i}: prefix must be a plain key prefix`);
    return {
      effect: 'allow' as const,
      actions: [...new Set(x.actions as (typeof ACTIONS)[number][])].sort(),
      prefix,
      principal: 'bucket-credentials' as const,
    };
  });
  let cors: BucketPolicyDoc['cors'];
  if (p.cors !== undefined) {
    if (!Array.isArray(p.cors) || p.cors.length > 10)
      throw bad('policy.cors must be a list of at most 10 rules');
    cors = p.cors.map((c, i) => {
      const r = c as { origins?: unknown; methods?: unknown; maxAgeSeconds?: unknown };
      if (
        !Array.isArray(r.origins) ||
        r.origins.length < 1 ||
        r.origins.length > 20 ||
        r.origins.some(
          (o) => typeof o !== 'string' || !/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(o),
        )
      )
        throw bad(`cors rule ${i}: origins must be exact http(s) origins (no wildcard)`);
      if (
        !Array.isArray(r.methods) ||
        r.methods.length < 1 ||
        r.methods.some((m) => !(CORS_METHODS as readonly unknown[]).includes(m))
      )
        throw bad(`cors rule ${i}: methods must be a subset of ${CORS_METHODS.join(', ')}`);
      if (
        !Number.isInteger(r.maxAgeSeconds) ||
        (r.maxAgeSeconds as number) < 0 ||
        (r.maxAgeSeconds as number) > 86_400
      )
        throw bad(`cors rule ${i}: maxAgeSeconds must be 0..86400`);
      return {
        origins: r.origins as string[],
        methods: r.methods as ('GET' | 'PUT' | 'HEAD')[],
        maxAgeSeconds: r.maxAgeSeconds as number,
      };
    });
  }
  return { version: 1, access: p.access, statements, ...(cors ? { cors } : {}) };
}
/** Stable ETag of a canonical policy document. */
export const policyEtag = (p: BucketPolicyDoc): string =>
  createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 32);
export const DEFAULT_POLICY: BucketPolicyDoc = { version: 1, access: 'private', statements: [] };

/** Lifecycle rules: expiry and multipart abort; transitions only when the provider supports them (checked by the service against the probe). */
export function parseLifecycle(raw: unknown): LifecycleRule[] {
  const rules = (raw as { rules?: unknown })?.rules ?? raw;
  if (!Array.isArray(rules) || rules.length > 50)
    throw new ProblemException(
      'validation_failed',
      'rules must be a list of at most 50 lifecycle rules',
    );
  const ids = new Set<string>();
  return rules.map((r, i) => {
    const x = r as Record<string, unknown>;
    if (
      typeof r !== 'object' ||
      r === null ||
      Object.keys(x).some(
        (k) =>
          !['id', 'prefix', 'expireDays', 'abortIncompleteMultipartDays', 'transition'].includes(k),
      )
    )
      throw new ProblemException('validation_failed', `rule ${i}: unknown field`);
    if (typeof x.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(x.id) || ids.has(x.id))
      throw new ProblemException(
        'validation_failed',
        `rule ${i}: id must be unique, 1..64 characters`,
      );
    ids.add(x.id);
    const prefix = x.prefix ?? '';
    if (typeof prefix !== 'string' || !KEY.test(prefix) || /[*?]|\.\./.test(prefix))
      throw new ProblemException(
        'validation_failed',
        `rule ${i}: prefix must be a plain key prefix`,
      );
    const days = (v: unknown, n: string) => {
      if (v === undefined) return undefined;
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 3650)
        throw new ProblemException('validation_failed', `rule ${i}: ${n} must be 1..3650 days`);
      return v as number;
    };
    const rule: LifecycleRule = { id: x.id, prefix };
    const e = days(x.expireDays, 'expireDays');
    const a = days(x.abortIncompleteMultipartDays, 'abortIncompleteMultipartDays');
    if (e !== undefined) rule.expireDays = e;
    if (a !== undefined) rule.abortIncompleteMultipartDays = a;
    if (x.transition !== undefined) {
      const t = x.transition as { days?: unknown; storageClass?: unknown };
      if (
        !Number.isInteger(t.days) ||
        typeof t.storageClass !== 'string' ||
        !/^[A-Z0-9_]{2,30}$/.test(t.storageClass)
      )
        throw new ProblemException(
          'validation_failed',
          `rule ${i}: transition needs days and a storageClass`,
        );
      rule.transition = { days: t.days as number, storageClass: t.storageClass };
    }
    if (
      rule.expireDays === undefined &&
      rule.abortIncompleteMultipartDays === undefined &&
      !rule.transition
    )
      throw new ProblemException('validation_failed', `rule ${i}: a rule needs an action`);
    return rule;
  });
}

/** An object key for a signed URL: relative, no traversal, no control characters, at most 1024 bytes. */
export function parseObjectKey(k: unknown): string {
  if (
    typeof k !== 'string' ||
    k.length < 1 ||
    Buffer.byteLength(k) > 1024 ||
    /[\u0000-\u001f\u007f\\]/.test(k) ||
    k.startsWith('/') ||
    k.split('/').some((seg) => seg === '..' || seg === '.')
  )
    throw new ProblemException(
      'validation_failed',
      'key must be a relative object key of at most 1024 bytes without control characters, backslashes or traversal segments',
    );
  return k;
}
