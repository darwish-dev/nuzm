import { randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../common/audit';
import { ProblemException } from '../../common/errors';
import { DnsTxtLookup } from '../domains';
import { MemberService } from '../tenancy';
import { MetadataError, parseIdpMetadata } from './saml/saml-metadata';
import { DnsTxtResolver, MetadataFetcher } from './ports';

/**
 * Enterprise SSO connections (M12 S55, FR-ENT-01/02/06). One row per connection, per organization. Public IdP metadata only is stored (config);
 * the OIDC client secret is a vault reference. Email domains are claimed with a DNS TXT proof (`_nuzm-sso.<domain>` = `nuzm-sso-verification=<token>`),
 * read first from the organization's own Nuzm zone (M07) and otherwise from public DNS. A domain is verified for exactly ONE organization.
 */
export const PROOF_PREFIX = 'nuzm-sso-verification=';
export const proofName = (domain: string) => `_nuzm-sso.${domain}`;
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'msn.com',
]);
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const JIT_ROLES = ['viewer', 'developer', 'billing_admin'];

export interface SsoConnectionDto {
  id: string;
  protocol: 'saml' | 'oidc';
  name: string;
  status: 'pending_domain_proof' | 'active' | 'disabled';
  domains: {
    domain: string;
    status: 'pending' | 'verified';
    txtName: string;
    txtValue: string | null;
    verifiedAt: string | null;
  }[];
  jit: { enabled: boolean; defaultRole: string };
  enforce: boolean;
  idpInitiated: boolean;
  config: Record<string, unknown>;
  sp: { entityId: string; acsUrl: string | null };
  testLogin: { available: boolean; reason: string | null; lastResult: unknown };
  createdAt: string;
  updatedAt: string;
}
type Row = Record<string, unknown>;

export class SsoConnectionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly fetcher: MetadataFetcher,
    private readonly dnsOrg: DnsTxtLookup,
    private readonly dnsPublic: DnsTxtResolver,
    private readonly members: MemberService,
  ) {}

  private bad(field: string, message: string): never {
    throw new ProblemException('validation_failed', message, [{ field, message }]);
  }

  private parseDomains(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 10)
      this.bad('domains', 'give 1 to 10 email domains');
    const out = new Set<string>();
    for (const d of raw as unknown[]) {
      const v = typeof d === 'string' ? d.trim().toLowerCase() : '';
      if (!DOMAIN.test(v) || v.length > 253)
        this.bad('domains', `"${String(d).slice(0, 60)}" is not a valid domain`);
      if (FREE_MAIL.has(v))
        this.bad('domains', `${v} is a public mail domain and cannot be claimed`);
      out.add(v);
    }
    return [...out];
  }

  private parseJit(raw: unknown): { enabled: boolean; defaultRole: string } {
    if (raw === undefined) return { enabled: false, defaultRole: 'viewer' };
    const j = raw as { enabled?: unknown; defaultRole?: unknown };
    if (typeof raw !== 'object' || raw === null || typeof j.enabled !== 'boolean')
      this.bad('jit', 'jit must be {enabled, defaultRole}');
    const role = j.defaultRole === undefined ? 'viewer' : j.defaultRole;
    if (typeof role !== 'string' || !JIT_ROLES.includes(role))
      this.bad(
        'jit.defaultRole',
        `defaultRole must be one of ${JIT_ROLES.join(', ')}: just-in-time provisioning never grants administrative roles`,
      );
    return { enabled: j.enabled, defaultRole: role };
  }

  private async metadataConfig(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    let xml: string;
    if (typeof body.xml === 'string') xml = body.xml;
    else if (typeof body.metadataUrl === 'string') {
      try {
        xml = await this.fetcher.fetch(body.metadataUrl);
      } catch (e) {
        throw new ProblemException(
          'invalid_sso_metadata',
          `metadata could not be fetched: ${(e as Error).message}`.slice(0, 200),
        );
      }
    } else this.bad('xml', 'a SAML connection needs xml or metadataUrl');
    try {
      const m = parseIdpMetadata(xml);
      return {
        entityId: m.entityId,
        ssoUrl: m.ssoUrl,
        ssoBinding: m.ssoBinding,
        certificates: m.certificates,
        wantAuthnRequestsSigned: m.wantAuthnRequestsSigned,
      };
    } catch (e) {
      if (e instanceof MetadataError) throw new ProblemException('invalid_sso_metadata', e.message);
      throw e;
    }
  }

  private toDto(c: Row, proofs: Row[]): SsoConnectionDto {
    const cfg = { ...(c.config as Record<string, unknown>) };
    const certs = Array.isArray(cfg.certificates) ? (cfg.certificates as string[]).length : 0;
    delete cfg.certificates;
    return {
      id: c.id as string,
      protocol: c.protocol as 'saml' | 'oidc',
      name: c.name as string,
      status: c.status as SsoConnectionDto['status'],
      domains: proofs.map((p) => ({
        domain: p.domain as string,
        status: p.status as 'pending' | 'verified',
        txtName: proofName(p.domain as string),
        txtValue: p.status === 'pending' ? `${PROOF_PREFIX}${p.token as string}` : null,
        verifiedAt: p.verified_at ? (p.verified_at as Date).toISOString() : null,
      })),
      jit: c.jit as { enabled: boolean; defaultRole: string },
      enforce: c.enforce as boolean,
      idpInitiated: c.idp_initiated as boolean,
      config: { ...cfg, signingCertificates: certs },
      sp: { entityId: `urn:nuzm:sso:${c.id as string}`, acsUrl: null },
      testLogin: {
        available: false,
        reason: 'the SSO sign-in endpoints are not part of the approved contract yet (SCR-M12-05)',
        lastResult: c.last_test_result ?? null,
      },
      createdAt: (c.created_at as Date).toISOString(),
      updatedAt: (c.updated_at as Date).toISOString(),
    };
  }

  async list(orgId: string): Promise<{ items: SsoConnectionDto[] }> {
    return this.db.withOrg(orgId, async (cl) => {
      const conns = (
        await cl.query<Row>(`SELECT * FROM identity.sso_connections ORDER BY created_at DESC, id`)
      ).rows;
      const proofs = (
        await cl.query<Row>(`SELECT * FROM identity.sso_domain_proofs ORDER BY domain`)
      ).rows;
      return {
        items: conns.map((c) =>
          this.toDto(
            c,
            proofs.filter((p) => p.connection_id === c.id),
          ),
        ),
      };
    });
  }

  async get(orgId: string, id: string): Promise<SsoConnectionDto | null> {
    const { items } = await this.list(orgId);
    return items.find((i) => i.id === id) ?? null;
  }

  /** POST: creates a connection, or (with `connectionId`) updates enforce / jit / idpInitiated / enabled / extra domains of an existing one. */
  async upsert(
    orgId: string,
    actor: { userId: string; ip?: string; traceId?: string },
    key: string,
    body: Record<string, unknown>,
  ): Promise<{ created: boolean; connection: SsoConnectionDto }> {
    if (typeof body.connectionId === 'string')
      return {
        created: false,
        connection: await this.update(orgId, actor, body.connectionId, body),
      };

    const protocol = body.protocol;
    if (protocol !== 'saml' && protocol !== 'oidc')
      this.bad('protocol', 'protocol must be saml or oidc');
    const name =
      typeof body.name === 'string' && body.name.trim().length >= 1 && body.name.length <= 120
        ? body.name.trim()
        : this.bad('name', 'name is required (1-120 characters)');
    const domains = this.parseDomains(body.domains);
    const jit = this.parseJit(body.jit);
    if (body.enforce === true)
      this.bad(
        'enforce',
        'enforcement cannot be set on a new connection: verify the domain and test the login first',
      );
    if ('clientSecret' in body || 'secret' in body)
      throw new ProblemException(
        'credential_value_rejected',
        'send a vault reference (clientSecretRef), never the secret',
      );

    let config: Record<string, unknown>;
    let vaultRef: string | null = null;
    if (protocol === 'saml') config = await this.metadataConfig(body);
    else {
      const issuer = typeof body.issuer === 'string' ? body.issuer.trim() : '';
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
      try {
        if (new URL(issuer).protocol !== 'https:') throw new Error('x');
      } catch {
        this.bad('issuer', 'issuer must be an https URL');
      }
      if (!clientId || clientId.length > 200) this.bad('clientId', 'clientId is required');
      if (typeof body.clientSecretRef !== 'string' || !body.clientSecretRef.startsWith('vault://'))
        this.bad('clientSecretRef', 'clientSecretRef must be a vault:// reference');
      config = { issuer, clientId };
      vaultRef = body.clientSecretRef;
    }

    const id = uuidv7();
    const result = await this.db.withOrg(orgId, async (cl) => {
      const existing = (
        await cl.query<Row>(
          `SELECT * FROM identity.sso_connections WHERE created_by = $1 AND idempotency_key = $2`,
          [actor.userId, key],
        )
      ).rows[0];
      if (existing) {
        const proofs = (
          await cl.query<Row>(
            `SELECT * FROM identity.sso_domain_proofs WHERE connection_id = $1 ORDER BY domain`,
            [existing.id],
          )
        ).rows;
        return { created: false, row: existing, proofs };
      }
      // a domain already VERIFIED by any organization cannot be claimed again (409)
      const taken = await this.db.withAuthScope(
        'sso_lookup',
        async (c2) =>
          (
            await c2.query<{ domain: string }>(
              `SELECT domain FROM identity.sso_domain_proofs WHERE status = 'verified' AND domain = ANY($1::text[]) AND org_id <> $2`,
              [domains, orgId],
            )
          ).rows,
      );
      if (taken.length)
        throw new ProblemException(
          'domain_claimed',
          `${taken[0]!.domain} is verified by another organization`,
        );
      const { rows } = await cl.query<Row>(
        `INSERT INTO identity.sso_connections (id, org_id, protocol, name, config, vault_ref, domains, jit, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          id,
          orgId,
          protocol,
          name,
          JSON.stringify(config),
          vaultRef,
          domains,
          JSON.stringify(jit),
          actor.userId,
          key,
        ],
      );
      const proofs: Row[] = [];
      for (const d of domains)
        proofs.push(
          (
            await cl.query<Row>(
              `INSERT INTO identity.sso_domain_proofs (id, org_id, connection_id, domain, token) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
              [uuidv7(), orgId, id, d, randomBytes(24).toString('base64url')],
            )
          ).rows[0]!,
        );
      await this.audit.record({
        action: 'sso.connection.created',
        orgId,
        actorUserId: actor.userId,
        resource: { type: 'sso_connection', id },
        outcome: 'success',
        ip: actor.ip,
        traceId: actor.traceId,
        after: { protocol, name, domains, jit, enforce: false },
      });
      return { created: true, row: rows[0]!, proofs };
    });
    return { created: result.created, connection: this.toDto(result.row, result.proofs) };
  }

  private async update(
    orgId: string,
    actor: { userId: string; ip?: string; traceId?: string },
    id: string,
    body: Record<string, unknown>,
  ): Promise<SsoConnectionDto> {
    await this.db.withOrg(orgId, async (cl) => {
      const cur = (
        await cl.query<Row>(`SELECT * FROM identity.sso_connections WHERE id = $1 FOR UPDATE`, [id])
      ).rows[0];
      if (!cur) throw new ProblemException('not_found');
      const jit =
        body.jit !== undefined
          ? this.parseJit(body.jit)
          : (cur.jit as { enabled: boolean; defaultRole: string });
      let enforce = cur.enforce as boolean;
      let status = cur.status as string;
      if (body.enabled === false) {
        status = 'disabled';
        enforce = false;
      } else if (body.enabled === true && status === 'disabled') {
        status = (cur.verified_domains as string[]).length ? 'active' : 'pending_domain_proof';
      }
      if (body.enforce !== undefined) {
        if (typeof body.enforce !== 'boolean') this.bad('enforce', 'enforce must be a boolean');
        if (body.enforce) {
          if (status !== 'active' || (cur.verified_domains as string[]).length === 0)
            this.bad(
              'enforce',
              'enforcement needs an active connection with at least one verified domain',
            );
          const t = cur.last_test_result as { ok?: boolean } | null;
          if (!t || t.ok !== true)
            this.bad(
              'enforce',
              'enforcement needs a successful test login first (the test login is not available yet: SCR-M12-05)',
            );
        }
        enforce = body.enforce;
      }
      const idpInitiated =
        body.idpInitiated !== undefined
          ? typeof body.idpInitiated === 'boolean'
            ? body.idpInitiated
            : this.bad('idpInitiated', 'must be a boolean')
          : (cur.idp_initiated as boolean);
      const added =
        body.domains !== undefined
          ? this.parseDomains(body.domains).filter((d) => !(cur.domains as string[]).includes(d))
          : [];
      if (added.length) {
        const taken = await this.db.withAuthScope(
          'sso_lookup',
          async (c2) =>
            (
              await c2.query<{ domain: string }>(
                `SELECT domain FROM identity.sso_domain_proofs WHERE status = 'verified' AND domain = ANY($1::text[]) AND org_id <> $2`,
                [added, orgId],
              )
            ).rows,
        );
        if (taken.length)
          throw new ProblemException(
            'domain_claimed',
            `${taken[0]!.domain} is verified by another organization`,
          );
        for (const d of added)
          await cl.query(
            `INSERT INTO identity.sso_domain_proofs (id, org_id, connection_id, domain, token) VALUES ($1,$2,$3,$4,$5)`,
            [uuidv7(), orgId, id, d, randomBytes(24).toString('base64url')],
          );
      }
      await cl.query(
        `UPDATE identity.sso_connections SET jit = $2, enforce = $3, status = $4, idp_initiated = $5, domains = domains || $6::text[], updated_at = now(), version = version + 1 WHERE id = $1`,
        [id, JSON.stringify(jit), enforce, status, idpInitiated, added],
      );
      const changedEnforce = enforce !== cur.enforce;
      await this.audit.record({
        action: changedEnforce
          ? enforce
            ? 'sso.connection.enforced'
            : 'sso.connection.unenforced'
          : 'sso.connection.updated',
        orgId,
        actorUserId: actor.userId,
        resource: { type: 'sso_connection', id },
        outcome: 'success',
        ip: actor.ip,
        traceId: actor.traceId,
        before: {
          enforce: cur.enforce,
          status: cur.status,
          jit: cur.jit,
          idpInitiated: cur.idp_initiated,
        },
        after: { enforce, status, jit, idpInitiated },
      });
    });
    return (await this.get(orgId, id))!;
  }

  /**
   * Verifies pending domain proofs (a platform job; also called by tests). A domain verified for another organization in the meantime stays pending
   * (the unique index refuses it). Returns the number of newly verified domains.
   */
  async verifyPendingDomains(limit = 100): Promise<number> {
    const pending = await this.db.withWorkerClaim(
      async (c) =>
        (
          await c.query<{
            id: string;
            org_id: string;
            connection_id: string;
            domain: string;
            token: string;
          }>(
            `SELECT id, org_id, connection_id, domain, token FROM identity.sso_domain_proofs WHERE status = 'pending' ORDER BY checked_at NULLS FIRST LIMIT $1`,
            [limit],
          )
        ).rows,
    );
    let verified = 0;
    for (const p of pending) {
      const name = proofName(p.domain);
      let values = await this.dnsOrg.findTxt(p.org_id, name).catch(() => null);
      if (values === null) values = await this.dnsPublic.txt(name).catch(() => []);
      const ok = values.some((v) => v.trim() === `${PROOF_PREFIX}${p.token}`);
      await this.db.withWorkerClaim(async (c) => {
        if (!ok) {
          await c.query(`UPDATE identity.sso_domain_proofs SET checked_at = now() WHERE id = $1`, [
            p.id,
          ]);
          return;
        }
        try {
          await c.query('SAVEPOINT v');
          await c.query(
            `UPDATE identity.sso_domain_proofs SET status = 'verified', verified_at = now(), checked_at = now() WHERE id = $1`,
            [p.id],
          );
          await c.query(
            `UPDATE identity.sso_connections SET verified_domains = (SELECT coalesce(array_agg(domain ORDER BY domain), '{}') FROM identity.sso_domain_proofs WHERE connection_id = $1 AND status = 'verified'),
               status = CASE WHEN status = 'pending_domain_proof' THEN 'active' ELSE status END, updated_at = now(), version = version + 1 WHERE id = $1`,
            [p.connection_id],
          );
          verified++;
        } catch (e) {
          if ((e as { code?: string }).code !== '23505') throw e;
          await c.query('ROLLBACK TO SAVEPOINT v');
          await c.query(`UPDATE identity.sso_domain_proofs SET checked_at = now() WHERE id = $1`, [
            p.id,
          ]);
        }
      });
      if (ok)
        await this.audit.record({
          action: 'sso.domain.verified',
          orgId: p.org_id,
          actorType: 'system',
          resource: { type: 'sso_connection', id: p.connection_id },
          outcome: 'success',
          detail: { domain: p.domain },
        });
    }
    return verified;
  }

  // ---- sign-in identity resolution (used by the SSO flow once SCR-M12-05 is approved; tested here) ---------------------------------------------
  async loadForLogin(connectionId: string): Promise<(Row & { org_id: string }) | null> {
    const rows = await this.db.withAuthScope(
      'sso_lookup',
      async (c) =>
        (
          await c.query<Row & { org_id: string }>(
            `SELECT * FROM identity.sso_connections WHERE id = $1`,
            [connectionId],
          )
        ).rows,
    );
    return rows[0] ?? null;
  }

  /**
   * Maps a validated IdP identity to a platform user and makes sure the organization membership exists. Order: the connection's own subject, then a
   * SCIM-provisioned or existing account with the same email, then (only when JIT is on) a new account. Refuses an email outside the connection's
   * VERIFIED domains, a disabled user and a user that is not provisioned when JIT is off. JIT assigns the connection's default role, never owner/admin.
   */
  async resolveLogin(
    conn: {
      id: string;
      org_id: string;
      verified_domains: string[];
      jit: { enabled: boolean; defaultRole: string };
      status: string;
    },
    who: { subject: string; email: string; displayName?: string | null },
  ): Promise<{ userId: string; createdUser: boolean; role: string }> {
    if (conn.status !== 'active')
      throw new ProblemException('forbidden', 'this SSO connection is not active');
    const email = who.email.trim().toLowerCase();
    const domain = email.slice(email.lastIndexOf('@') + 1);
    if (!conn.verified_domains.includes(domain))
      throw new ProblemException(
        'forbidden',
        'the email domain is not verified for this connection',
      );
    const issuer = `sso:${conn.id}`;
    const user = await this.db.withoutScope(async (c) => {
      const bySubject = (
        await c.query<Row>(
          `SELECT id, status FROM identity.users WHERE issuer = $1 AND subject = $2`,
          [issuer, who.subject],
        )
      ).rows[0];
      if (bySubject)
        return { id: bySubject.id as string, status: bySubject.status as string, created: false };
      const byEmail = (
        await c.query<Row>(
          `SELECT id, status, issuer FROM identity.users WHERE lower(email) = $1 AND is_platform_user = false ORDER BY (issuer = $2) DESC, created_at LIMIT 1`,
          [email, issuer],
        )
      ).rows[0];
      if (byEmail) {
        if (byEmail.issuer === issuer)
          await c
            .query(`UPDATE identity.users SET subject = $2, last_login_at = now() WHERE id = $1`, [
              byEmail.id,
              who.subject,
            ])
            .catch(() => undefined);
        return { id: byEmail.id as string, status: byEmail.status as string, created: false };
      }
      if (!conn.jit.enabled) return null;
      const id = uuidv7();
      await c.query(
        `INSERT INTO identity.users (id, issuer, subject, email, email_verified, display_name, last_login_at) VALUES ($1,$2,$3,$4,true,$5, now())`,
        [id, issuer, who.subject, email, who.displayName ?? null],
      );
      return { id, status: 'active', created: true };
    });
    if (!user)
      throw new ProblemException(
        'forbidden',
        'this account is not provisioned and just-in-time provisioning is off',
      );
    if (user.status !== 'active')
      throw new ProblemException('forbidden', 'this account is disabled');
    const m = await this.db.withOrg(
      conn.org_id,
      async (c) =>
        (
          await c.query<{ role: string }>(
            `SELECT role FROM tenancy.memberships WHERE user_id = $1`,
            [user.id],
          )
        ).rows[0],
    );
    if (m) return { userId: user.id, createdUser: user.created, role: m.role };
    if (!conn.jit.enabled)
      throw new ProblemException(
        'forbidden',
        'this account is not a member of the organization and just-in-time provisioning is off',
      );
    const added = await this.members.add(conn.org_id, user.id, conn.jit.defaultRole, {
      via: 'sso.jit',
    });
    return { userId: user.id, createdUser: user.created, role: added.role };
  }
}
