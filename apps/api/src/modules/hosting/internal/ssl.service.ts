import { X509Certificate, createPrivateKey } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type { Db, OperationsService } from '@nuzm/platform';
import type { AuditSink } from '../../../common/audit';
import { ProblemException } from '../../../common/errors';
import { tokenFor } from './hosting-names';
import type { HostingConfig } from './config';
import type { HostingAdapter, VaultPort } from './ports';
import { KIND, type Caller, type SitesService } from './sites.service';

type Row = Record<string, unknown>;
const iso = (d: unknown) => (d ? (d as Date).toISOString() : null);
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export interface CertDto {
  id: string;
  mode: 'managed' | 'custom';
  domains: string[];
  status: 'pending' | 'issued' | 'failed' | 'removed';
  notAfter: string | null;
  renewAfter: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** days until expiry, for the "expiring" warning of UI-M06-06 */
  expiresInDays: number | null;
  createdAt: string;
}

/** Attempts before a managed certificate is marked `failed` (it can still be re-requested). PROPOSAL. */
export const MAX_CERT_ATTEMPTS = 6;
/** Backoff after a failed attempt: 1h, 2h, 4h … capped at 7 days; a CA rate-limit answer waits at least 6h (rate limits are weekly/hourly at CAs). PROPOSAL. */
export function backoffMs(attempts: number, rateLimited: boolean): number {
  const base = Math.min(2 ** Math.max(attempts - 1, 0), 168) * 3_600_000;
  return rateLimited ? Math.max(base, 6 * 3_600_000) : base;
}

/**
 * TLS certificates (M06 §4 task 8). Managed = issued ON THE NODE through the agent (the control plane never speaks ACME); renewal starts `renewBeforeDays`
 * (default 30, proposal) before expiry; failures back off. Custom = the customer uploads certificate + private key: the key goes straight to the vault under a
 * `secret_ref` and is never stored in the database, an audit event, a log line, an operation row or a response.
 */
export class SslService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditSink,
    private readonly ops: OperationsService,
    private readonly sites: SitesService,
    private readonly adapter: HostingAdapter,
    private readonly vault: VaultPort,
    private readonly cfg: HostingConfig,
    private readonly clock: () => Date = () => new Date(),
    private readonly kick: (orgId: string, operationId: string) => void = () => undefined,
  ) {}

  private dto(r: Row): CertDto {
    const na = r.not_after as Date | null;
    return {
      id: r.id as string,
      mode: r.mode as CertDto['mode'],
      domains: r.domains as string[],
      status: r.status as CertDto['status'],
      notAfter: iso(na),
      renewAfter: iso(r.renew_after),
      attempts: r.attempts as number,
      nextAttemptAt: iso(r.next_attempt_at),
      lastError: (r.last_error as string | null) ?? null,
      expiresInDays: na ? Math.floor((na.getTime() - this.clock().getTime()) / 86_400_000) : null,
      createdAt: iso(r.created_at)!,
    };
  }
  async list(orgId: string, siteId: string): Promise<{ items: CertDto[] }> {
    await this.sites.row(orgId, siteId);
    const rows = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM hosting.ssl_certificates WHERE site_id = $1 AND org_id = $2 AND status <> 'removed' ORDER BY created_at DESC`,
            [siteId, orgId],
          )
        ).rows,
    );
    return { items: rows.map((r) => this.dto(r)) };
  }

  /** Validate an uploaded certificate + key pair structurally (no secret is echoed in any error). */
  static parseCustom(
    certificate: unknown,
    privateKey: unknown,
  ): { notAfter: Date; names: string[] } {
    if (
      typeof certificate !== 'string' ||
      typeof privateKey !== 'string' ||
      certificate.length > 20_000 ||
      privateKey.length > 10_000
    )
      throw new ProblemException(
        'validation_failed',
        'certificate and privateKey must be PEM strings',
      );
    try {
      const cert = new X509Certificate(certificate);
      const key = createPrivateKey(privateKey);
      if (!cert.checkPrivateKey(key)) throw new Error('mismatch');
      const names = [...(cert.subjectAltName?.matchAll(/DNS:([^,\s]+)/g) ?? [])].map((m) =>
        m[1]!.toLowerCase(),
      );
      return { notAfter: new Date(cert.validTo), names };
    } catch {
      throw new ProblemException(
        'validation_failed',
        'the certificate or the private key is not valid, or they do not belong together',
      ); // never repeats the material
    }
  }

  async request(
    orgId: string,
    actor: Caller,
    siteId: string,
    body: Record<string, unknown>,
  ): Promise<{ certificate: CertDto; operationId: string }> {
    await this.sites.row(orgId, siteId); // the site first: another organization's id is a 404 whatever the body says
    const allowed = new Set(['mode', 'domains', 'certRef', 'certificate', 'privateKey', 'chain']);
    for (const k of Object.keys(body))
      if (!allowed.has(k)) throw new ProblemException('validation_failed', `unknown member ${k}`);
    const mode = body.mode;
    if (mode !== 'managed' && mode !== 'custom')
      throw new ProblemException('validation_failed', "mode must be 'managed' or 'custom'");
    const domains = Array.isArray(body.domains)
      ? body.domains.map((d) => (typeof d === 'string' ? d.toLowerCase() : ''))
      : [];
    if (
      domains.length < 1 ||
      domains.length > 20 ||
      domains.some((d) => !DOMAIN.test(d)) ||
      new Set(domains).size !== domains.length
    )
      throw new ProblemException(
        'validation_failed',
        'domains must be 1..20 distinct domain names',
      );
    const site = await this.sites.row(orgId, siteId);
    if (site.status !== 'active')
      throw new ProblemException(
        'site_not_active',
        'certificates can be issued for an active site',
      );
    // every domain must be a verified/active binding of THIS site: an unverified domain never gets a certificate or a vhost
    const bound = await this.db.withOrg(orgId, async (c) =>
      (
        await c.query(
          `SELECT domain FROM hosting.site_domain_bindings WHERE site_id = $1 AND state = 'active'`,
          [siteId],
        )
      ).rows.map((r) => r.domain as string),
    );
    const missing = domains.filter((d) => !bound.includes(d));
    if (missing.length)
      throw new ProblemException(
        'ownership_unverified',
        `these domains are not bound and verified on the site: ${missing.join(', ')}`,
      );

    const id = uuidv7();
    let secretRef: string | null = null;
    let notAfter: Date | null = null;
    if (mode === 'custom') {
      if (typeof body.certRef === 'string') {
        if (
          !/^vault:\/\/(?!.*\.\.)[A-Za-z0-9/_.-]{3,200}$/.test(body.certRef) ||
          !(await this.vault.exists(body.certRef))
        )
          throw new ProblemException('validation_failed', 'certRef does not resolve in the vault');
        secretRef = body.certRef;
      } else {
        const parsed = SslService.parseCustom(body.certificate, body.privateKey);
        if (parsed.notAfter.getTime() <= this.clock().getTime())
          throw new ProblemException('validation_failed', 'the certificate has expired');
        const covered = (d: string) =>
          parsed.names.some(
            (n) =>
              n === d ||
              (n.startsWith('*.') &&
                d.endsWith(n.slice(1)) &&
                d.split('.').length === n.split('.').length),
          );
        if (domains.some((d) => !covered(d)))
          throw new ProblemException(
            'validation_failed',
            'the certificate does not cover every requested domain',
          );
        secretRef = `vault://hosting/org/${orgId}/site/${siteId}/cert/${id}`;
        await this.vault.put(
          secretRef,
          JSON.stringify({
            privateKey: body.privateKey,
            certificate: body.certificate,
            chain: body.chain ?? null,
          }),
        );
        notAfter = parsed.notAfter;
      }
    }
    const row = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `INSERT INTO hosting.ssl_certificates (id, site_id, org_id, domains, mode, secret_ref, not_after) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [id, siteId, orgId, domains, mode, secretRef, notAfter],
          )
        ).rows[0]!,
    );
    const op = await this.ops.create(orgId, {
      kind: KIND.ssl,
      input: { siteId, certId: id },
      resourceKind: 'hosting_site',
      resourceId: siteId,
      createdBy: actor.userId,
      maxAttempts: 3,
    });
    await this.db.withOrg(orgId, (c) =>
      c.query(`UPDATE hosting.ssl_certificates SET operation_id = $2 WHERE id = $1`, [id, op.id]),
    );
    await this.audit.record({
      action: 'hosting.ssl.requested',
      actorUserId: actor.userId,
      actorType: 'user',
      orgId,
      resource: { type: 'hosting_ssl', id },
      outcome: 'success',
      detail: { mode, domains: domains.length },
    });
    this.kick(orgId, op.id);
    return { certificate: this.dto(row), operationId: op.id };
  }

  /** One issuance ATTEMPT (called by the operation and by the renewal sweep). Never throws for a CA/node failure: it records it and schedules the backoff. */
  async attempt(
    orgId: string,
    certId: string,
  ): Promise<{ status: string; nextAttemptAt: string | null }> {
    const cert = await this.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT c.*, s.node_name, s.node_id, s.status AS site_status FROM hosting.ssl_certificates c JOIN hosting.sites s ON s.id = c.site_id WHERE c.id = $1 AND c.org_id = $2`,
            [certId, orgId],
          )
        ).rows[0],
    );
    if (!cert) throw new ProblemException('not_found', 'certificate not found');
    if (cert.status === 'removed' || cert.site_status !== 'active')
      return { status: cert.status as string, nextAttemptAt: null };
    const node = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(`SELECT id, compute_instance_id FROM hosting.nodes WHERE id = $1`, [
            cert.node_id,
          ])
        ).rows[0],
    );
    const attemptNo = (cert.attempts as number) + 1;
    // the token carries the expiry of the certificate being replaced: a RENEWAL is a new command, never an idempotent replay of the first issuance
    const generation = cert.not_after ? (cert.not_after as Date).getTime() : 0;
    const t = {
      idempotencyToken: tokenFor(orgId, `${certId}:${generation}:${attemptNo}`, 'issue_cert'),
      operationId: `ssl-${certId}-${generation}-${attemptNo}`,
    };
    const r = await this.adapter.issueCertificate(
      this.sites.ctx(t.operationId),
      { nodeId: node!.id as string, computeInstanceId: node!.compute_instance_id as string },
      cert.node_name as string,
      {
        domains: cert.domains as string[],
        mode: cert.mode as 'managed' | 'custom',
        ...(cert.secret_ref ? { customCertRef: cert.secret_ref as string } : {}),
      },
      t,
    );
    const now = this.clock();
    if (r.status === 'succeeded' && r.data) {
      const notAfter =
        cert.mode === 'custom' && cert.not_after
          ? (cert.not_after as Date)
          : new Date(r.data.notAfter);
      const renewAfter =
        cert.mode === 'managed'
          ? new Date(notAfter.getTime() - this.cfg.renewBeforeDays * 86_400_000)
          : null;
      await this.db.withOrg(orgId, (c) =>
        c.query(
          `UPDATE hosting.ssl_certificates SET status = 'issued', not_after = $2, issued_at = $5, renew_after = $3, node_cert_id = $4, attempts = 0, next_attempt_at = NULL, last_error = NULL, updated_at = now() WHERE id = $1`,
          [certId, notAfter, renewAfter, r.data!.certId.slice(0, 80), now],
        ),
      );
      const wasRenewal = !!cert.issued_at;
      await this.audit.record({
        action: wasRenewal ? 'hosting.ssl.renewed' : 'hosting.ssl.issued',
        actorType: 'system',
        orgId,
        resource: { type: 'hosting_ssl', id: certId },
        outcome: 'success',
        detail: { mode: cert.mode as string, notAfter: notAfter.toISOString() },
      });
      return { status: 'issued', nextAttemptAt: null };
    }
    const code = r.error?.providerCode ?? (r.status === 'uncertain' ? 'uncertain' : 'failed');
    const rateLimited = r.error?.category === 'rate_limit';
    const last =
      attemptNo >= MAX_CERT_ATTEMPTS ||
      r.error?.category === 'validation' ||
      r.error?.category === 'unsupported';
    const next = last ? null : new Date(now.getTime() + backoffMs(attemptNo, rateLimited));
    await this.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE hosting.ssl_certificates SET attempts = $2, next_attempt_at = $3, last_error = $4, status = CASE WHEN $5 THEN 'failed' ELSE status END, updated_at = now() WHERE id = $1`,
        [certId, attemptNo, next, String(code).slice(0, 190), last],
      ),
    );
    await this.audit.record({
      action: 'hosting.ssl.failed',
      actorType: 'system',
      orgId,
      resource: { type: 'hosting_ssl', id: certId },
      outcome: 'failure',
      detail: { code: String(code), attempt: attemptNo, giveUp: last },
    });
    return { status: last ? 'failed' : 'pending', nextAttemptAt: next ? next.toISOString() : null };
  }

  /** Renewal + retry sweep: managed certificates whose renewal time has come, and pending ones whose backoff elapsed. */
  async sweep(now = this.clock()): Promise<{ renewed: number; retried: number; failed: number }> {
    const due = await this.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT c.id, c.org_id, c.status, c.issued_at FROM hosting.ssl_certificates c JOIN hosting.sites s ON s.id = c.site_id
            WHERE s.status = 'active' AND ((c.status = 'issued' AND c.mode = 'managed' AND c.renew_after <= $1) OR (c.status = 'pending' AND c.next_attempt_at IS NOT NULL AND c.next_attempt_at <= $1))
            ORDER BY c.renew_after NULLS LAST LIMIT 100`,
            [now],
          )
        ).rows,
    );
    const out = { renewed: 0, retried: 0, failed: 0 };
    for (const d of due) {
      const orgId = d.org_id as string;
      if (d.status === 'issued')
        await this.db.withOrg(orgId, (c) =>
          c.query(
            `UPDATE hosting.ssl_certificates SET status = 'pending', attempts = 0, next_attempt_at = NULL WHERE id = $1`,
            [d.id],
          ),
        );
      const r = await this.attempt(orgId, d.id as string);
      if (r.status === 'issued') {
        if (d.status === 'issued') out.renewed++;
        else out.retried++;
      } else if (r.status === 'failed') out.failed++;
    }
    return out;
  }
}
