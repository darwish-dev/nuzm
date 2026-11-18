import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import { CircuitBreaker, SafeHttpClient, SsrfError, TokenBucket, checkUrl } from '@nuzm/domain';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { decodeCursor, pageOf, type Page } from '../../../common/pagination';
import type { SecretStore } from '../../../common/secrets';
import {
  DEFAULT_DATA_REGION,
  NO_SECRET_REF,
  badRequest,
  isTenantRef,
  isUuid,
  iso,
  pgCode,
  rejectRawSecrets,
  scopeCovers,
  tenantSecretId,
  type Row,
} from './model';
import { ActionError } from './ports';

export interface ConnectorDto {
  id: string;
  type: 'nuzm' | 'http' | 'oauth2' | 'email';
  name: string;
  scopes: string[];
  rateLimit: { perMinute: number; burst: number };
  config: Record<string, unknown>;
  status: 'pending' | 'active' | 'revoked' | 'disabled';
  authorization: {
    status: 'none' | 'pending' | 'active' | 'revoked' | 'expired';
    expiresAt: string | null;
    scopes: string[];
  } | null;
  dataRegion: string;
  etag: number;
  createdAt: string;
}
export interface ResolvedConnector {
  id: string;
  type: ConnectorDto['type'];
  config: Record<string, unknown>;
  scopes: string[];
  transferAssessmentId: string | null;
  /** The credential (token) the step may send. NEVER persisted, logged or returned. */
  secret?: string;
}

const TYPES = ['nuzm', 'http', 'oauth2', 'email'] as const;
const SCOPE = /^[a-z][a-z0-9_-]{0,40}(:[a-z0-9_*-]{1,40}){0,3}$/;
const CONFIG_KEYS: Record<string, string[]> = {
  nuzm: [],
  email: [],
  http: ['allowedHosts', 'authType', 'headerName', 'hostRegion'],
  oauth2: [
    'authorizationUrl',
    'tokenUrl',
    'clientId',
    'redirectUris',
    'allowedHosts',
    'hostRegion',
  ],
};

/**
 * Connectors (M11 S52): what a workflow may call, with which scopes, and the authorization that backs it (vault references only).
 * Fail closed: a step that names a connector which is missing, not active, revoked, expired, outside the org, or lacking the needed scope is refused with
 * `403 connector_not_authorized`. Token-bucket rate limit and a circuit breaker run per connector (per process: the multi-instance behaviour is NOT VERIFIED).
 */
export class ConnectorService {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly secrets: SecretStore,
    private readonly http: SafeHttpClient,
    private readonly clock: () => number = Date.now,
  ) {}

  private dto(r: Row, a?: Row | null): ConnectorDto {
    let auth: ConnectorDto['authorization'] = null;
    if (a) {
      const expired =
        a.status === 'active' && a.expires_at && (a.expires_at as Date).getTime() <= this.clock();
      auth = {
        status: expired ? 'expired' : a.status,
        expiresAt: iso(a.expires_at),
        scopes: a.scopes,
      };
    }
    return {
      id: r.id,
      type: r.type,
      name: r.name,
      scopes: r.scopes,
      rateLimit: r.rate_limit,
      config: r.config,
      status: r.status,
      authorization: auth ?? { status: 'none', expiresAt: null, scopes: [] },
      dataRegion: r.data_region,
      etag: r.version_lock,
      createdAt: iso(r.created_at)!,
    };
  }

  private validateConfig(type: ConnectorDto['type'], cfg: unknown): Record<string, unknown> {
    if (cfg === undefined) cfg = {};
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
      throw badRequest('config must be an object');
    const c = cfg as Record<string, unknown>;
    for (const k of Object.keys(c))
      if (!CONFIG_KEYS[type]!.includes(k))
        throw badRequest(`config.${k} is not allowed for a ${type} connector`);
    const urls = (v: unknown, field: string) => {
      if (typeof v !== 'string') throw badRequest(`config.${field} is required`);
      try {
        checkUrl(v);
      } catch (e) {
        if (e instanceof SsrfError)
          throw new ProblemException('ssrf_denied', `config.${field}: ${e.message}`);
        throw e;
      }
    };
    if (type === 'oauth2') {
      urls(c.authorizationUrl, 'authorizationUrl');
      urls(c.tokenUrl, 'tokenUrl');
      if (typeof c.clientId !== 'string' || c.clientId.length < 1 || c.clientId.length > 200)
        throw badRequest('config.clientId is required');
      if (
        c.redirectUris !== undefined &&
        (!Array.isArray(c.redirectUris) ||
          c.redirectUris.some((u) => typeof u !== 'string' || !/^https:\/\//.test(u)))
      )
        throw badRequest('config.redirectUris must be https URLs');
    }
    if (type === 'http') {
      if (
        !Array.isArray(c.allowedHosts) ||
        c.allowedHosts.length < 1 ||
        c.allowedHosts.length > 20 ||
        c.allowedHosts.some(
          (h) => typeof h !== 'string' || !/^(\*\.)?[a-z0-9.-]+\.[a-z]{2,}$/.test(h),
        )
      )
        throw badRequest(
          'config.allowedHosts must list 1..20 host names (e.g. api.example.com or *.example.com)',
        );
      for (const h of c.allowedHosts as string[]) {
        try {
          checkUrl(`https://${h.replace(/^\*\./, 'x.')}/`);
        } catch (e) {
          if (e instanceof SsrfError)
            throw new ProblemException('ssrf_denied', `config.allowedHosts: ${h}: ${e.message}`);
          throw e;
        }
      }
      if (c.authType !== undefined && !['bearer', 'header', 'none'].includes(String(c.authType)))
        throw badRequest("config.authType must be 'bearer', 'header' or 'none'");
      if (
        c.headerName !== undefined &&
        (typeof c.headerName !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(c.headerName))
      )
        throw badRequest('config.headerName is not a header name');
    }
    if (
      c.hostRegion !== undefined &&
      (typeof c.hostRegion !== 'string' || !/^[A-Za-z0-9-]{2,40}$/.test(c.hostRegion))
    )
      throw badRequest('config.hostRegion is not a region id');
    return c;
  }

  async create(orgId: string, actor: string, body: Record<string, unknown>): Promise<ConnectorDto> {
    rejectRawSecrets(body);
    for (const k of Object.keys(body))
      if (!['type', 'name', 'scopes', 'rateLimit', 'config'].includes(k))
        throw badRequest(`unknown field ${k}`);
    if (!TYPES.includes(body.type as never))
      throw badRequest(`type must be one of ${TYPES.join(', ')}`);
    const type = body.type as ConnectorDto['type'];
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) throw badRequest('name must be 1..120 characters');
    const scopes = body.scopes ?? [];
    if (
      !Array.isArray(scopes) ||
      scopes.length > 50 ||
      scopes.some((s) => typeof s !== 'string' || !SCOPE.test(s))
    )
      throw badRequest('scopes must be a list of scope names like projects:read');
    if (type === 'nuzm' && scopes.length === 0)
      throw badRequest('a Nuzm connector must declare at least one scope');
    const rl = (body.rateLimit ?? { perMinute: 60, burst: 10 }) as {
      perMinute?: unknown;
      burst?: unknown;
    };
    if (
      !Number.isInteger(rl.perMinute) ||
      (rl.perMinute as number) < 1 ||
      (rl.perMinute as number) > 6000 ||
      !Number.isInteger(rl.burst) ||
      (rl.burst as number) < 1 ||
      (rl.burst as number) > 1000
    )
      throw badRequest('rateLimit needs perMinute 1..6000 and burst 1..1000');
    const config = this.validateConfig(type, body.config);
    try {
      const row = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `INSERT INTO automation.connectors (id, org_id, type, name, scopes, rate_limit, config, status, data_region, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING *`,
              [
                uuidv7(),
                orgId,
                type,
                name,
                [...new Set(scopes as string[])],
                JSON.stringify({ perMinute: rl.perMinute, burst: rl.burst }),
                JSON.stringify(config),
                DEFAULT_DATA_REGION,
                actor,
              ],
            )
          ).rows[0],
      )) as Row;
      await this.audit.record({
        action: 'connector.connector.created',
        actorUserId: actor,
        orgId,
        resource: { type: 'connector', id: row.id },
        outcome: 'success',
        after: { type, name, scopes: row.scopes },
      });
      return this.dto(row, null);
    } catch (e) {
      if (pgCode(e) === '23505')
        throw new ProblemException('name_taken', 'a connector with this name already exists');
      throw e;
    }
  }

  private async latestAuth(c: import('pg').PoolClient, connectorId: string): Promise<Row | null> {
    return (
      ((
        await c.query(
          `SELECT * FROM automation.connector_authorizations WHERE connector_id = $1 AND status <> 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
          [connectorId],
        )
      ).rows[0] as Row) ?? null
    );
  }

  async list(orgId: string, q: { limit: number; cursor?: string }): Promise<Page<ConnectorDto>> {
    const before = decodeCursor(q.cursor);
    const items = await this.db.withOrg(orgId, async (c) => {
      const rows = (
        await c.query(
          `SELECT * FROM automation.connectors WHERE org_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
          [orgId, before, q.limit + 1],
        )
      ).rows as Row[];
      const out: { r: Row; a: Row | null }[] = [];
      for (const r of rows) out.push({ r, a: await this.latestAuth(c, r.id) });
      return out;
    });
    const p = pageOf(
      items.map((i) => ({ id: i.r.id as string, i })),
      q.limit,
    );
    return { items: p.items.map((x) => this.dto(x.i.r, x.i.a)), nextCursor: p.nextCursor };
  }

  async get(orgId: string, id: string): Promise<ConnectorDto> {
    if (!isUuid(id)) throw new ProblemException('not_found');
    const x = await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM automation.connectors WHERE id = $1 AND org_id = $2`, [
          id,
          orgId,
        ])
      ).rows[0] as Row | undefined;
      return r ? { r, a: await this.latestAuth(c, id) } : null;
    });
    if (!x) throw new ProblemException('not_found');
    return this.dto(x.r, x.a);
  }

  /** `POST /v1/connectors/{id}/authorization`: store a vault-ref credential, start OAuth (PKCE) or complete it. */
  async authorize(
    orgId: string,
    actor: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    rejectRawSecrets(body);
    const conn = (await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(`SELECT * FROM automation.connectors WHERE id = $1 AND org_id = $2`, [
            id,
            orgId,
          ])
        ).rows[0],
    )) as Row | undefined;
    if (!conn) throw new ProblemException('not_found');
    if (conn.status === 'revoked' || conn.status === 'disabled')
      throw new ProblemException('invalid_state', `the connector is ${conn.status}`);
    const kind = body.kind;
    const scopesIn = body.scopes === undefined ? conn.scopes : body.scopes;
    if (!Array.isArray(scopesIn) || scopesIn.some((s) => typeof s !== 'string'))
      throw badRequest('scopes must be a list of strings');
    // a token can never carry MORE than the connector declares (scope escalation is refused here and again at every step)
    if ((scopesIn as string[]).some((s) => !conn.scopes.includes(s)))
      throw new ProblemException(
        'connector_not_authorized',
        'the authorization requests a scope the connector does not declare',
      );
    const scopes = [...new Set(scopesIn as string[])];

    if (kind === 'credential') {
      if (conn.type === 'oauth2')
        throw badRequest('an OAuth2 connector is authorized with oauth2_start / oauth2_complete');
      let ref: unknown = body.vaultRef;
      if (conn.type === 'email') ref = NO_SECRET_REF;
      else if (!isTenantRef(orgId, ref))
        throw new ProblemException(
          'credential_value_rejected',
          'vaultRef must be a reference to a secret of THIS organization (vault://…/tenant-<orgId>-…)',
        );
      const exp = body.expiresAt === undefined ? null : new Date(String(body.expiresAt));
      if (exp && (Number.isNaN(exp.getTime()) || exp.getTime() <= this.clock()))
        throw badRequest('expiresAt must be a future date');
      return this.activate(orgId, actor, conn, ref as string, scopes, exp);
    }
    if (kind === 'oauth2_start') {
      if (conn.type !== 'oauth2') throw badRequest('oauth2_start is only for OAuth2 connectors');
      const redirect = body.redirectUri;
      const allowed = (conn.config.redirectUris as string[] | undefined) ?? [];
      if (
        typeof redirect !== 'string' ||
        !/^https:\/\//.test(redirect) ||
        (allowed.length > 0 && !allowed.includes(redirect))
      )
        throw badRequest('redirectUri must be an https URL declared in the connector config');
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const state = randomBytes(24).toString('base64url');
      const authId = uuidv7();
      const verifierRef = await this.secrets.put(
        tenantSecretId(orgId, 'pkce', authId),
        JSON.stringify({ verifier, redirect }),
      );
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `INSERT INTO automation.connector_authorizations (id, org_id, connector_id, vault_ref, scopes, status, authorized_by, oauth_state_hash, pkce_verifier_ref) VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
          [
            authId,
            orgId,
            id,
            NO_SECRET_REF,
            scopes,
            actor,
            createHash('sha256').update(state).digest('hex'),
            verifierRef,
          ],
        ),
      );
      const u = new URL(conn.config.authorizationUrl as string);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', conn.config.clientId as string);
      u.searchParams.set('redirect_uri', redirect);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', challenge);
      u.searchParams.set('code_challenge_method', 'S256');
      if (scopes.length) u.searchParams.set('scope', scopes.join(' '));
      return { authorizationId: authId, status: 'pending', authorizationUrl: u.toString(), state };
    }
    if (kind === 'oauth2_complete') {
      if (conn.type !== 'oauth2') throw badRequest('oauth2_complete is only for OAuth2 connectors');
      if (
        typeof body.state !== 'string' ||
        typeof body.code !== 'string' ||
        body.code.length < 1 ||
        body.code.length > 2000
      )
        throw badRequest('state and code are required');
      const stateHash = createHash('sha256').update(body.state).digest('hex');
      const pend = (await this.db.withOrg(
        orgId,
        async (c) =>
          (
            await c.query(
              `SELECT * FROM automation.connector_authorizations WHERE connector_id = $1 AND oauth_state_hash = $2 AND status = 'pending'`,
              [id, stateHash],
            )
          ).rows[0],
      )) as Row | undefined;
      if (!pend)
        throw new ProblemException(
          'invalid_token',
          'the OAuth state is unknown, used or belongs to another connector',
        );
      const saved = JSON.parse(await this.secrets.get(pend.pkce_verifier_ref)) as {
        verifier: string;
        redirect: string;
      };
      let tokenRes;
      try {
        tokenRes = await this.http.request({
          url: conn.config.tokenUrl as string,
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: body.code,
            redirect_uri: saved.redirect,
            client_id: conn.config.clientId as string,
            code_verifier: saved.verifier,
          }).toString(),
        });
      } catch (e) {
        if (e instanceof SsrfError) throw new ProblemException('ssrf_denied', e.message);
        throw e;
      }
      let tok: { access_token?: string; refresh_token?: string; expires_in?: number } = {};
      try {
        tok = JSON.parse(tokenRes.body);
      } catch {
        /* handled below */
      }
      if (tokenRes.status !== 200 || typeof tok.access_token !== 'string')
        throw new ProblemException(
          'invalid_token',
          'the token endpoint did not return an access token',
        );
      const aid = uuidv7();
      const ref = await this.secrets.put(
        tenantSecretId(orgId, 'oauth', aid),
        JSON.stringify({ access_token: tok.access_token, refresh_token: tok.refresh_token }),
      );
      await this.secrets.delete(pend.pkce_verifier_ref);
      const exp =
        typeof tok.expires_in === 'number' && tok.expires_in > 0
          ? new Date(this.clock() + Math.min(tok.expires_in, 365 * 86400) * 1000)
          : null;
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE automation.connector_authorizations SET status = 'active', vault_ref = $2, expires_at = $3, oauth_state_hash = NULL, pkce_verifier_ref = NULL WHERE id = $1`,
          [pend.id, ref, exp],
        ),
      );
      await this.afterAuthorized(orgId, actor, conn, pend.id);
      return { authorizationId: pend.id, status: 'active', expiresAt: iso(exp) };
    }
    throw badRequest("kind must be 'credential', 'oauth2_start' or 'oauth2_complete'");
  }

  private async activate(
    orgId: string,
    actor: string,
    conn: Row,
    ref: string,
    scopes: string[],
    exp: Date | null,
  ) {
    const authId = uuidv7();
    await this.db.withOrg(orgId, async (c) => {
      // a new authorization replaces the previous one: only the newest active authorization counts, older ones are revoked
      await c.query(
        `UPDATE automation.connector_authorizations SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE connector_id = $1 AND status = 'active'`,
        [conn.id, actor],
      );
      await c.query(
        `INSERT INTO automation.connector_authorizations (id, org_id, connector_id, vault_ref, scopes, status, expires_at, authorized_by) VALUES ($1,$2,$3,$4,$5,'active',$6,$7)`,
        [authId, orgId, conn.id, ref, scopes, exp, actor],
      );
    });
    await this.afterAuthorized(orgId, actor, conn, authId);
    return { authorizationId: authId, status: 'active', expiresAt: iso(exp) };
  }
  private async afterAuthorized(orgId: string, actor: string, conn: Row, authId: string) {
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE automation.connectors SET status = 'active' WHERE id = $1 AND status = 'pending'`,
        [conn.id],
      ),
    );
    await this.audit.record({
      action: 'connector.connector.authorized',
      actorUserId: actor,
      orgId,
      resource: { type: 'connector', id: conn.id },
      outcome: 'success',
      detail: { authorizationId: authId },
    });
  }

  /** Revoke (service-level: the HTTP route is SCR-M11-04, BLOCKED pending owner approval). Running executions stop at their NEXT step (every step re-checks). */
  async revoke(orgId: string, actor: string, id: string): Promise<void> {
    const n = await this.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE automation.connector_authorizations SET status = 'revoked', revoked_at = now(), revoked_by = $2 WHERE connector_id = $1 AND status IN ('active','pending')`,
        [id, actor],
      );
      await c.query(
        `UPDATE automation.connectors SET status = 'revoked' WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      return r.rowCount ?? 0;
    });
    this.breakers.delete(id);
    await this.audit.record({
      action: 'connector.connector.revoked',
      actorUserId: actor,
      orgId,
      resource: { type: 'connector', id },
      outcome: 'success',
      detail: { authorizations: n },
    });
  }

  /**
   * The runtime gate for a step that names a connector. Returns what the step may use or throws `connector_not_authorized` (403): the step fails closed.
   * `requiredScope` is checked against the connector's declared scopes AND the authorization's granted scopes.
   */
  async resolve(
    orgId: string,
    connectorId: string,
    requiredScope?: string,
  ): Promise<ResolvedConnector> {
    const denied = (why: string) => new ProblemException('connector_not_authorized', why);
    if (!isUuid(connectorId)) throw denied('unknown connector');
    const x = await this.db.withOrg(orgId, async (c) => {
      const r = (
        await c.query(`SELECT * FROM automation.connectors WHERE id = $1 AND org_id = $2`, [
          connectorId,
          orgId,
        ])
      ).rows[0] as Row | undefined;
      return r ? { r, a: await this.latestAuth(c, connectorId) } : null;
    });
    if (!x) throw denied('the connector is not authorized in this organization');
    const { r, a } = x;
    if (r.status !== 'active') throw denied(`the connector is ${r.status}`);
    if (!a || a.status !== 'active') throw denied('the connector authorization is not active');
    if (a.expires_at && (a.expires_at as Date).getTime() <= this.clock())
      throw denied('the connector authorization has expired');
    if (
      requiredScope &&
      !(scopeCovers(r.scopes, requiredScope) && scopeCovers(a.scopes, requiredScope))
    )
      throw denied(`the connector does not grant the scope ${requiredScope}`);
    let secret: string | undefined;
    if (a.vault_ref !== NO_SECRET_REF) {
      const raw = await this.secrets.get(a.vault_ref);
      secret =
        r.type === 'oauth2' ? (JSON.parse(raw) as { access_token: string }).access_token : raw;
    }
    return {
      id: r.id,
      type: r.type,
      config: r.config,
      scopes: r.scopes,
      transferAssessmentId: r.transfer_assessment_id ?? null,
      secret,
    };
  }

  /** Rate limit + breaker gate, called right before the call goes out. Retryable errors: the step backs off. */
  acquire(connectorId: string, rate: { perMinute: number; burst: number }): void {
    const now = this.clock();
    let b = this.buckets.get(connectorId);
    if (!b)
      this.buckets.set(connectorId, (b = new TokenBucket(rate.burst, rate.perMinute / 60, now)));
    const br =
      this.breakers.get(connectorId) ??
      this.breakers.set(connectorId, new CircuitBreaker()).get(connectorId)!;
    if (!br.allow(now))
      throw new ActionError('circuit_open', 'the connector circuit breaker is open', {
        retryable: true,
      });
    if (!b.take(now))
      throw new ActionError(
        'rate_limited',
        `the connector rate limit is reached; retry in ${b.retryAfterSeconds(now)} s`,
        { retryable: true },
      );
  }
  async rateOf(orgId: string, connectorId: string): Promise<{ perMinute: number; burst: number }> {
    const r = (await this.db.withOrg(
      orgId,
      async (c) =>
        (await c.query(`SELECT rate_limit FROM automation.connectors WHERE id = $1`, [connectorId]))
          .rows[0],
    )) as Row | undefined;
    return r?.rate_limit ?? { perMinute: 60, burst: 10 };
  }
  outcome(connectorId: string, ok: boolean) {
    const br = this.breakers.get(connectorId);
    if (!br) return;
    if (ok) br.success();
    else br.failure(this.clock());
  }
}
