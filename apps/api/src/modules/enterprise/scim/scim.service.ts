import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { MemberService } from '../../tenancy';
import { SessionService } from '../../identity';
import { evaluate, parseFilter, ScimFilterError, type Attrs } from './scim-filter';
import type { ScimPrincipal } from './scim-tokens.service';

export const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly scimType: string | undefined,
    detail: string,
  ) {
    super(detail);
  }
}

/** Groups are the org's NON-administrative roles (owner/admin are never exposed or assignable through SCIM: privilege comes from people, not the IdP). */
export const GROUP_ROLES = ['billing_admin', 'developer', 'viewer'] as const;
const MAX_MEMBERS = 10_000;
type Row = Record<string, unknown>;

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  displayName?: string;
  emails: { value: string; primary: boolean }[];
  active: boolean;
  groups: { value: string; display: string }[];
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

const bool = (v: unknown): boolean | undefined =>
  typeof v === 'boolean'
    ? v
    : typeof v === 'string' && /^(true|false)$/i.test(v)
      ? v.toLowerCase() === 'true'
      : undefined;

export class ScimService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly members: MemberService,
    private readonly sessions: SessionService,
    private readonly base: () => string,
  ) {}

  // ---- discovery ------------------------------------------------------------------------------------------------------------------------------
  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'docs/runbooks/scim-failure.md',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'Bearer token',
          description: 'Organization-scoped SCIM token',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${this.base()}/scim/v2/ServiceProviderConfig`,
      },
    };
  }
  resourceTypes() {
    return [
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'User',
        name: 'User',
        endpoint: '/Users',
        schema: SCHEMA_USER,
      },
      {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
        id: 'Group',
        name: 'Group',
        endpoint: '/Groups',
        schema: SCHEMA_GROUP,
      },
    ];
  }
  schemas() {
    return [
      {
        id: SCHEMA_USER,
        name: 'User',
        description: 'Organization member',
        attributes: ['userName', 'externalId', 'displayName', 'name', 'emails', 'active'].map(
          (n) => ({
            name: n,
            type: n === 'active' ? 'boolean' : 'string',
            multiValued: n === 'emails',
            required: n === 'userName',
            mutability: 'readWrite',
          }),
        ),
      },
      {
        id: SCHEMA_GROUP,
        name: 'Group',
        description: 'A non-administrative organization role (read-only membership mapping)',
        attributes: [
          {
            name: 'displayName',
            type: 'string',
            multiValued: false,
            required: true,
            mutability: 'readOnly',
          },
          {
            name: 'members',
            type: 'complex',
            multiValued: true,
            required: false,
            mutability: 'readWrite',
          },
        ],
      },
    ];
  }

  // ---- users ----------------------------------------------------------------------------------------------------------------------------------
  private async rows(p: ScimPrincipal): Promise<Row[]> {
    return this.db.withOrg(p.orgId, async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT u.id, u.email, u.display_name, u.status, m.role, m.created_at AS joined, m.updated_at AS modified, i.external_id, i.deprovisioned_at, i.created_at AS scim_created
           FROM identity.scim_identities i JOIN identity.users u ON u.id = i.user_id LEFT JOIN tenancy.memberships m ON m.user_id = i.user_id
          WHERE i.org_id = $1 ORDER BY u.email LIMIT $2`,
        [p.orgId, MAX_MEMBERS + 1],
      );
      if (rows.length > MAX_MEMBERS)
        throw new ScimError(
          400,
          'tooMany',
          `more than ${MAX_MEMBERS} provisioned users; narrow the query`,
        );
      return rows;
    });
  }
  private user(r: Row): ScimUser {
    const active =
      r.role !== null &&
      r.role !== undefined &&
      r.deprovisioned_at === null &&
      r.status === 'active';
    const name = (r.display_name as string | null) ?? undefined;
    return {
      schemas: [SCHEMA_USER],
      id: r.id as string,
      externalId: r.external_id as string,
      userName: r.email as string,
      ...(name ? { name: { formatted: name }, displayName: name } : {}),
      emails: [{ value: r.email as string, primary: true }],
      active,
      groups:
        active && GROUP_ROLES.includes(r.role as never)
          ? [{ value: r.role as string, display: r.role as string }]
          : [],
      meta: {
        resourceType: 'User',
        created: ((r.scim_created ?? r.joined ?? new Date()) as Date).toISOString(),
        lastModified: ((r.modified ?? r.scim_created ?? new Date()) as Date).toISOString(),
        location: `${this.base()}/scim/v2/Users/${r.id as string}`,
      },
    };
  }
  private attrs(u: ScimUser): Attrs {
    return {
      id: u.id,
      externalid: u.externalId,
      username: u.userName,
      displayname: u.displayName,
      'name.formatted': u.name?.formatted,
      active: u.active,
      'emails.value': u.emails[0]!.value,
      emails: u.emails[0]!.value,
      'meta.lastmodified': u.meta.lastModified,
    };
  }

  async listUsers(p: ScimPrincipal, q: { filter?: string; startIndex?: number; count?: number }) {
    const start = Math.max(1, Math.floor(q.startIndex ?? 1));
    const count = Math.min(200, Math.max(0, Math.floor(q.count ?? 100)));
    let node;
    try {
      node = q.filter ? parseFilter(q.filter) : null;
    } catch (e) {
      if (e instanceof ScimFilterError) throw new ScimError(400, 'invalidFilter', e.message);
      throw e;
    }
    const all = (await this.rows(p))
      .map((r) => this.user(r))
      .filter((u) => !node || evaluate(node, this.attrs(u)));
    return {
      schemas: [SCHEMA_LIST],
      totalResults: all.length,
      startIndex: start,
      itemsPerPage: Math.min(count, Math.max(0, all.length - (start - 1))),
      Resources: all.slice(start - 1, start - 1 + count),
    };
  }

  async getUser(p: ScimPrincipal, id: string): Promise<ScimUser> {
    const r = (await this.rows(p)).find((x) => x.id === id);
    if (!r) throw new ScimError(404, undefined, 'User not found');
    return this.user(r);
  }

  private email(body: Row): string {
    const fromEmails = Array.isArray(body.emails)
      ? ((body.emails as Row[]).find((e) => e.primary === true) ?? (body.emails as Row[])[0])?.value
      : undefined;
    const raw =
      typeof body.userName === 'string'
        ? body.userName
        : typeof fromEmails === 'string'
          ? fromEmails
          : '';
    const email = raw.trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,255}$/.test(email))
      throw new ScimError(400, 'invalidValue', 'userName must be an email address');
    return email;
  }
  private displayName(body: Row): string | null {
    if (typeof body.displayName === 'string') return body.displayName.slice(0, 200);
    const n = body.name as Row | undefined;
    if (n && typeof n.formatted === 'string') return n.formatted.slice(0, 200);
    if (n && (n.givenName || n.familyName))
      return (
        `${String(n.givenName ?? '')} ${String(n.familyName ?? '')}`.trim().slice(0, 200) || null
      );
    return null;
  }

  private async conn(p: ScimPrincipal) {
    const c = await this.db.withOrg(
      p.orgId,
      async (cl) =>
        (
          await cl.query<{
            status: string;
            verified_domains: string[];
            jit: { defaultRole: string };
          }>(`SELECT status, verified_domains, jit FROM identity.sso_connections WHERE id = $1`, [
            p.connectionId,
          ])
        ).rows[0],
    );
    if (!c || c.status === 'disabled')
      throw new ScimError(403, undefined, 'the SSO connection of this token is disabled');
    return c;
  }

  /** Idempotent by externalId: the same externalId returns the existing user (200) instead of a duplicate. */
  async createUser(p: ScimPrincipal, body: Row): Promise<{ user: ScimUser; created: boolean }> {
    const conn = await this.conn(p);
    const email = this.email(body);
    const externalId =
      typeof body.externalId === 'string' &&
      body.externalId.length > 0 &&
      body.externalId.length <= 255
        ? body.externalId
        : email;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!conn.verified_domains.includes(domain))
      throw new ScimError(
        400,
        'invalidValue',
        'the email domain is not a verified domain of this connection',
      );
    const active = bool(body.active) ?? true;
    const existing = await this.db.withOrg(
      p.orgId,
      async (c) =>
        (
          await c.query<Row>(
            `SELECT user_id, deprovisioned_at FROM identity.scim_identities WHERE external_id = $1`,
            [externalId],
          )
        ).rows[0],
    );
    if (existing) {
      const u = await this.getUser(p, existing.user_id as string).catch(() => null);
      if (u && u.userName !== email)
        throw new ScimError(
          409,
          'uniqueness',
          'externalId is already used by a different userName',
        );
      if (existing.deprovisioned_at !== null && active)
        return {
          user: await this.reactivate(p, existing.user_id as string, conn.jit.defaultRole),
          created: false,
        };
      return { user: u ?? (await this.getUser(p, existing.user_id as string)), created: false };
    }
    const issuer = `sso:${p.connectionId}`;
    const userId = await this.db.withoutScope(async (c) => {
      const clash = (
        await c.query<Row>(
          `SELECT i.org_id FROM identity.users u LEFT JOIN identity.scim_identities i ON i.user_id = u.id AND i.org_id = $2 WHERE lower(u.email) = $1 AND u.issuer = $3`,
          [email, p.orgId, issuer],
        )
      ).rows[0];
      if (clash && clash.org_id)
        throw new ScimError(409, 'uniqueness', 'a user with this userName already exists');
      const any = (
        await c.query<Row>(
          `SELECT id, status FROM identity.users WHERE lower(email) = $1 AND is_platform_user = false ORDER BY (issuer = $2) DESC, created_at LIMIT 1`,
          [email, issuer],
        )
      ).rows[0];
      if (any) return any.id as string;
      const id = uuidv7();
      await c.query(
        `INSERT INTO identity.users (id, issuer, subject, email, email_verified, display_name) VALUES ($1,$2,$3,$4,true,$5)`,
        [id, issuer, externalId, email, this.displayName(body)],
      );
      return id;
    });
    try {
      await this.db.withOrg(p.orgId, (c) =>
        c.query(
          `INSERT INTO identity.scim_identities (id, org_id, connection_id, external_id, user_id) VALUES ($1,$2,$3,$4,$5)`,
          [uuidv7(), p.orgId, p.connectionId, externalId, userId],
        ),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505')
        throw new ScimError(409, 'uniqueness', 'a user with this userName already exists');
      throw e;
    }
    if (active) await this.members.add(p.orgId, userId, conn.jit.defaultRole, { via: 'scim' });
    await this.audit.record({
      action: 'scim.user.provisioned',
      orgId: p.orgId,
      actorType: 'system',
      resource: { type: 'user', id: userId },
      outcome: 'success',
      detail: { externalId, active, tokenId: p.tokenId },
    });
    return { user: await this.getUser(p, userId), created: true };
  }

  private async reactivate(p: ScimPrincipal, userId: string, role: string): Promise<ScimUser> {
    await this.db.withOrg(p.orgId, (c) =>
      c.query(
        `UPDATE identity.scim_identities SET deprovisioned_at = NULL, updated_at = now() WHERE user_id = $1`,
        [userId],
      ),
    );
    await this.db.withoutScope((c) =>
      c.query(`UPDATE identity.users SET status = 'active' WHERE id = $1 AND issuer = $2`, [
        userId,
        `sso:${p.connectionId}`,
      ]),
    );
    await this.members.add(p.orgId, userId, role, { via: 'scim' });
    await this.audit.record({
      action: 'scim.user.provisioned',
      orgId: p.orgId,
      actorType: 'system',
      resource: { type: 'user', id: userId },
      outcome: 'success',
      detail: { reactivated: true, tokenId: p.tokenId },
    });
    return this.getUser(p, userId);
  }

  /** Deprovision: membership removed, API keys the user created in this organization revoked, all sessions revoked, SCIM-owned account disabled. */
  async deprovision(p: ScimPrincipal, userId: string): Promise<{ elapsedMs: number }> {
    const t0 = Date.now();
    await this.getUser(p, userId);
    try {
      await this.members
        .remove(p.orgId, { userId, role: 'owner' }, userId)
        .catch((e: { code?: string }) => {
          if (e.code === 'conflict')
            throw new ScimError(409, 'mutability', 'the last owner cannot be deprovisioned');
          if (e.code !== 'not_found') throw e;
        });
    } catch (e) {
      throw e;
    }
    await this.db.withOrg(p.orgId, async (c) => {
      await c.query(
        `UPDATE identity.api_keys SET revoked_at = now() WHERE org_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
        [p.orgId, userId],
      );
      await c.query(
        `UPDATE identity.scim_identities SET deprovisioned_at = now(), updated_at = now() WHERE user_id = $1`,
        [userId],
      );
    });
    const revoked = await this.sessions.revokeAllForUser(userId);
    await this.db.withoutScope((c) =>
      c
        .query(
          `UPDATE identity.users SET status = 'disabled' WHERE id = $1 AND issuer = $2 AND NOT EXISTS (SELECT 1 FROM tenancy.memberships WHERE user_id = $1)`,
          [userId, `sso:${p.connectionId}`],
        )
        .catch(() => undefined),
    );
    const elapsedMs = Date.now() - t0;
    await this.audit.record({
      action: 'scim.user.deprovisioned',
      orgId: p.orgId,
      actorType: 'system',
      resource: { type: 'user', id: userId },
      outcome: 'success',
      detail: { sessionsRevoked: revoked, elapsedMs, tokenId: p.tokenId },
    });
    return { elapsedMs };
  }

  async replaceUser(p: ScimPrincipal, id: string, body: Row): Promise<ScimUser> {
    const cur = await this.getUser(p, id);
    const email = this.email(body);
    if (email !== cur.userName)
      throw new ScimError(400, 'mutability', 'userName cannot be changed');
    await this.applyProfile(p, id, {
      displayName: this.displayName(body),
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
    });
    const active = bool(body.active);
    if (active !== undefined) await this.setActive(p, id, active);
    return this.getUser(p, id);
  }

  private async applyProfile(
    p: ScimPrincipal,
    id: string,
    v: { displayName?: string | null; externalId?: string },
  ) {
    if (v.displayName !== undefined && v.displayName !== null)
      await this.db.withoutScope((c) =>
        c.query(`UPDATE identity.users SET display_name = $2 WHERE id = $1`, [id, v.displayName]),
      );
    if (v.externalId) {
      try {
        await this.db.withOrg(p.orgId, (c) =>
          c.query(
            `UPDATE identity.scim_identities SET external_id = $2, updated_at = now() WHERE user_id = $1`,
            [id, v.externalId],
          ),
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ScimError(409, 'uniqueness', 'externalId is already in use');
        throw e;
      }
    }
  }
  private async setActive(p: ScimPrincipal, id: string, active: boolean) {
    const cur = await this.getUser(p, id);
    if (active === cur.active) return;
    if (!active) await this.deprovision(p, id);
    else await this.reactivate(p, id, (await this.conn(p)).jit.defaultRole);
  }

  async patchUser(p: ScimPrincipal, id: string, body: Row): Promise<ScimUser> {
    if (!Array.isArray(body.Operations) || (body.Operations as unknown[]).length === 0)
      throw new ScimError(400, 'invalidSyntax', 'Operations is required');
    await this.getUser(p, id);
    for (const op of body.Operations as Row[]) {
      const kind = typeof op.op === 'string' ? op.op.toLowerCase() : '';
      if (!['add', 'replace', 'remove'].includes(kind))
        throw new ScimError(400, 'invalidSyntax', `unknown op ${String(op.op)}`);
      const path = typeof op.path === 'string' ? op.path.toLowerCase() : undefined;
      const set = async (key: string, value: unknown) => {
        switch (key) {
          case 'active': {
            const b = bool(value);
            if (b === undefined)
              throw new ScimError(400, 'invalidValue', 'active must be a boolean');
            return this.setActive(p, id, kind === 'remove' ? false : b);
          }
          case 'displayname':
          case 'name.formatted':
            return this.applyProfile(p, id, {
              displayName: typeof value === 'string' ? value.slice(0, 200) : null,
            });
          case 'externalid':
            return this.applyProfile(p, id, { externalId: String(value) });
          case 'username':
            if (
              typeof value !== 'string' ||
              value.trim().toLowerCase() !== (await this.getUser(p, id)).userName
            )
              throw new ScimError(400, 'mutability', 'userName cannot be changed');
            return;
          case 'name':
          case 'emails':
          case 'name.givenname':
          case 'name.familyname':
            return;
          default:
            throw new ScimError(400, 'noTarget', `unsupported attribute ${key}`);
        }
      };
      if (path) await set(path, op.value);
      else if (op.value && typeof op.value === 'object')
        for (const [k, v] of Object.entries(op.value as Row)) await set(k.toLowerCase(), v);
      else
        throw new ScimError(400, 'invalidSyntax', 'an operation needs a path or an object value');
    }
    return this.getUser(p, id);
  }

  async deleteUser(p: ScimPrincipal, id: string) {
    await this.deprovision(p, id);
  }

  // ---- groups (non-administrative roles) ------------------------------------------------------------------------------------------------------
  private async groupMembers(p: ScimPrincipal, role: string) {
    const rows = (await this.rows(p)).filter((r) => r.role === role && r.deprovisioned_at === null);
    return rows.map((r) => ({
      value: r.id as string,
      display: r.email as string,
      $ref: `${this.base()}/scim/v2/Users/${r.id as string}`,
    }));
  }
  private async group(p: ScimPrincipal, role: string) {
    return {
      schemas: [SCHEMA_GROUP],
      id: role,
      displayName: role,
      members: await this.groupMembers(p, role),
      meta: { resourceType: 'Group', location: `${this.base()}/scim/v2/Groups/${role}` },
    };
  }
  async listGroups(p: ScimPrincipal) {
    const Resources = await Promise.all(GROUP_ROLES.map((r) => this.group(p, r)));
    return {
      schemas: [SCHEMA_LIST],
      totalResults: Resources.length,
      startIndex: 1,
      itemsPerPage: Resources.length,
      Resources,
    };
  }
  async getGroup(p: ScimPrincipal, id: string) {
    if (!GROUP_ROLES.includes(id as never)) throw new ScimError(404, undefined, 'Group not found');
    return this.group(p, id);
  }
  async patchGroup(p: ScimPrincipal, id: string, body: Row) {
    if (!GROUP_ROLES.includes(id as never)) throw new ScimError(404, undefined, 'Group not found');
    if (!Array.isArray(body.Operations))
      throw new ScimError(400, 'invalidSyntax', 'Operations is required');
    for (const op of body.Operations as Row[]) {
      const kind = String(op.op).toLowerCase();
      const ids: string[] = Array.isArray(op.value)
        ? (op.value as Row[]).map((m) => String(m.value))
        : typeof op.path === 'string'
          ? [...String(op.path).matchAll(/value eq "([^"]+)"/g)].map((m) => m[1]!)
          : [];
      if (
        !['add', 'remove', 'replace'].includes(kind) ||
        (typeof op.path === 'string' && !String(op.path).toLowerCase().startsWith('members'))
      )
        throw new ScimError(400, 'invalidPath', 'only members can be changed');
      for (const uid of ids)
        await this.setRole(
          p,
          uid,
          kind === 'remove' ? 'viewer' : id,
          kind === 'remove' ? id : undefined,
        );
    }
    return this.group(p, id);
  }
  private async setRole(p: ScimPrincipal, userId: string, role: string, onlyIfCurrently?: string) {
    await this.getUser(p, userId);
    const m = await this.db.withOrg(
      p.orgId,
      async (c) =>
        (
          await c.query<{ role: string; version: number }>(
            `SELECT role, version FROM tenancy.memberships WHERE user_id = $1`,
            [userId],
          )
        ).rows[0],
    );
    if (!m) throw new ScimError(404, undefined, 'the user is not an active member');
    if (m.role === 'owner' || m.role === 'admin')
      throw new ScimError(
        403,
        'mutability',
        'owner and admin roles cannot be changed through SCIM',
      );
    if (onlyIfCurrently && m.role !== onlyIfCurrently) return;
    if (m.role === role) return;
    await this.members.changeRole(p.orgId, { userId, role: 'owner' }, userId, role, m.version);
    await this.audit.record({
      action: 'scim.group.membership_changed',
      orgId: p.orgId,
      actorType: 'system',
      resource: { type: 'user', id: userId },
      outcome: 'success',
      before: { role: m.role },
      after: { role },
      detail: { tokenId: p.tokenId },
    });
  }
}
