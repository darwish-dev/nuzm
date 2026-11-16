import type { AuditSink } from '../../../common/audit';
import { BlockList, isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../common/errors';

const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // argon2id (OWASP min profile)

export interface ApiKeyPrincipal {
  keyId: string;
  orgId: string;
  scopes: string[];
  createdBy: string;
}

export interface CreateApiKey {
  name: string;
  scopes: string[];
  expiresAt?: Date | null;
  ipAllowList?: string[];
}

/** `project:*` in the allowed set covers any `project:<x>`; otherwise exact match. */
export function permissionCovers(allowed: ReadonlySet<string>, needed: string): boolean {
  if (allowed.has(needed) || allowed.has('*')) return true;
  const i = needed.indexOf(':');
  return i > 0 && allowed.has(`${needed.slice(0, i)}:*`);
}

/** Every requested scope must be covered by the creator's own permissions (api_key_scope_subset). */
export function scopesExceeding(
  requested: readonly string[],
  creatorPermissions: ReadonlySet<string>,
): string[] {
  return requested.filter((s) => !permissionCovers(creatorPermissions, s));
}

export function ipAllowed(ip: string, allowList: readonly string[]): boolean {
  if (allowList.length === 0) return true;
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const fam = isIP(addr);
  if (!fam) return false;
  const bl = new BlockList();
  for (const e of allowList) {
    const [base, bits] = e.split('/');
    const f = isIP(base ?? '');
    if (!base || !f) continue;
    if (bits === undefined) bl.addAddress(base, f === 4 ? 'ipv4' : 'ipv6');
    else bl.addSubnet(base, Number(bits), f === 4 ? 'ipv4' : 'ipv6');
  }
  return bl.check(addr, fam === 4 ? 'ipv4' : 'ipv6');
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Key format: `nzk_<8-char id>_<43-char secret>`; only the argon2id hash of the secret is stored. */
export class ApiKeyService {
  private readonly cache = new Map<string, { p: ApiKeyPrincipal | null; exp: number }>();
  private dummyHash?: string;

  constructor(
    private readonly db: Db,
    private readonly cacheMs = 30_000,
    /** When set, key creation/revocation are audited inside the same transaction (fail-closed). */
    private readonly audit?: AuditSink,
  ) {}

  async create(
    orgId: string,
    createdBy: string,
    req: CreateApiKey,
    creatorPermissions: ReadonlySet<string>,
  ) {
    if (!req.name.trim() || req.scopes.length === 0)
      throw new ProblemException('validation_failed', 'name and at least one scope are required');
    const over = scopesExceeding(req.scopes, creatorPermissions);
    if (over.length)
      throw new ProblemException(
        'validation_failed',
        'scope exceeds creator permissions',
        over.map((s) => ({ field: 'scopes', scope: s })),
      );
    for (const e of req.ipAllowList ?? []) {
      const [b, bits] = e.split('/');
      if (!isIP(b ?? '') || (bits !== undefined && !/^\d{1,3}$/.test(bits)))
        throw new ProblemException('validation_failed', `invalid ip allow-list entry ${e}`);
    }
    const prefix = `nzk_${randomBytes(6).toString('base64url').slice(0, 8)}`;
    const secret = randomBytes(32).toString('base64url');
    const id = uuidv7();
    await this.db.withOrg(orgId, async (c) => {
      await c.query(
        `INSERT INTO identity.api_keys (id, org_id, created_by, name, prefix, secret_hash, scopes, ip_allow_list, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          id,
          orgId,
          createdBy,
          req.name.trim(),
          prefix,
          await argonHash(secret, ARGON),
          req.scopes,
          req.ipAllowList ?? [],
          req.expiresAt ?? null,
        ],
      );
      await this.audit?.record({
        action: 'identity.api_key.created',
        orgId,
        actorUserId: createdBy,
        resource: { type: 'api_key', id },
        outcome: 'success',
        after: { name: req.name.trim(), prefix, scopes: req.scopes },
      });
    });
    return { id, prefix, key: `${prefix}_${secret}` }; // `key` is shown exactly once
  }

  async list(orgId: string, opts: { createdBy?: string } = {}) {
    return this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT id, name, prefix, scopes, ip_allow_list, expires_at, last_used_at, revoked_at, created_at, created_by
             FROM identity.api_keys WHERE ($1::uuid IS NULL OR created_by = $1) ORDER BY id DESC`,
            [opts.createdBy ?? null],
          )
        ).rows,
    );
  }

  /** `onlyCreatedBy` restricts non-admin callers to their own keys (a foreign key is then simply "not found"). */
  async revoke(orgId: string, id: string, opts: { onlyCreatedBy?: string } = {}): Promise<boolean> {
    this.cache.clear();
    return this.db.withOrg(orgId, async (c) => {
      const revoked = Boolean(
        (
          await c.query(
            `UPDATE identity.api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR created_by = $2)`,
            [id, opts.onlyCreatedBy ?? null],
          )
        ).rowCount,
      );
      if (revoked)
        await this.audit?.record({
          action: 'identity.api_key.revoked',
          orgId,
          resource: { type: 'api_key', id },
          outcome: 'success',
        });
      return revoked;
    });
  }

  /** Create a replacement with identical scopes/limits and revoke the old key in one transaction. */
  async rotate(orgId: string, id: string, rotatedBy: string) {
    const old = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT name, scopes, ip_allow_list, expires_at FROM identity.api_keys WHERE id=$1 AND revoked_at IS NULL`,
            [id],
          )
        ).rows[0],
    );
    if (!old) throw new ProblemException('not_found');
    const created = await this.create(
      orgId,
      rotatedBy,
      {
        name: old.name,
        scopes: old.scopes,
        ipAllowList: old.ip_allow_list,
        expiresAt: old.expires_at,
      },
      new Set(old.scopes as string[]),
    );
    await this.revoke(orgId, id);
    return created;
  }

  /** Returns the principal or null: every failure is indistinguishable to the caller (uniform 401). */
  async authenticate(raw: string, ip: string): Promise<ApiKeyPrincipal | null> {
    const m = /^(nzk_[A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{43})$/.exec(raw);
    if (!m) return null;
    const ck = sha(`${raw}|${ip}`);
    const hit = this.cache.get(ck);
    if (hit && hit.exp > Date.now()) return hit.p;

    const row = await this.db.withAuthScope(
      'api_key_lookup',
      async (c) =>
        (
          await c.query<{
            id: string;
            org_id: string;
            created_by: string;
            secret_hash: string;
            scopes: string[];
            ip_allow_list: string[];
            expires_at: Date | null;
            revoked_at: Date | null;
          }>(
            `SELECT id, org_id, created_by, secret_hash, scopes, ip_allow_list, expires_at, revoked_at FROM identity.api_keys WHERE prefix=$1`,
            [m[1]],
          )
        ).rows[0],
    );
    this.dummyHash ??= await argonHash('dummy-secret-for-timing', ARGON);
    // Always spend one argon2 verification so "unknown prefix" and "wrong secret" take similar time.
    const secretOk = await argonVerify(row?.secret_hash ?? this.dummyHash, m[2]!).catch(
      () => false,
    );
    let principal: ApiKeyPrincipal | null = null;
    if (
      row &&
      secretOk &&
      !row.revoked_at &&
      (!row.expires_at || row.expires_at.getTime() > Date.now()) &&
      ipAllowed(ip, row.ip_allow_list)
    ) {
      principal = {
        keyId: row.id,
        orgId: row.org_id,
        scopes: row.scopes,
        createdBy: row.created_by,
      };
      void this.db
        .withOrg(row.org_id, (c) =>
          c.query(
            `UPDATE identity.api_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
            [row.id],
          ),
        )
        .catch(() => undefined);
    }
    this.cache.set(ck, { p: principal, exp: Date.now() + this.cacheMs });
    return principal;
  }
}
