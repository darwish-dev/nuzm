import type { Db } from '@nuzm/platform';
import { ProblemException } from '../../../../common/errors';
import type { HestiaClient, HestiaResult } from '../hestia/client';
import type { HestiaCommandId } from '../hestia/commands';
import type { PlanRow } from '../plans.service';
import type { SitesService } from '../sites.service';
import type { ToolsConfig } from './tools-config';

type Row = Record<string, unknown>;
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const str = (v: unknown): string =>
  typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);

/** The node facts the tools depend on (platform scope: the registry is the platform's, a customer never sees it). */
export interface ToolNode {
  id: string;
  status: string;
  health: string;
  panelVersion: string | null;
  panelHost: string | null;
  panelConfigured: boolean;
  runtimes: string[];
  services: {
    ftp: string | null;
    mail: string | null;
    imap: string | null;
    webmail: string | null;
  } | null;
  sftpHostKey: string | null;
}
/** A site as the tools see it: verified from the caller's organization, never from the request. */
export interface ToolSite {
  id: string;
  orgId: string;
  status: string;
  nodeId: string;
  /** the on-node account (a Hestia user) that IS the site */
  account: string;
  primaryDomain: string | null;
  credentialsRef: string;
  runtime: string;
  plan: PlanRow;
}

/**
 * What every tool service needs: the caller's site (404 for another organization's id: RLS hides the row), its node, the plan's limits and a way to run an allow-listed
 * panel command that turns a failure into a Problem the API can answer. Nothing a browser sent ever becomes a host, command or credential here.
 */
export class ToolContext {
  constructor(
    readonly db: Db,
    readonly sites: SitesService,
    private readonly client: HestiaClient,
    readonly cfg: ToolsConfig,
  ) {}

  async site(orgId: string, id: string, requireActive = true): Promise<ToolSite> {
    const r = await this.sites.row(orgId, id);
    if (requireActive && r.status !== 'active')
      throw new ProblemException('site_not_active', 'the site is not active');
    const plan = await this.sites.plans.load(r.plan_id as string);
    if (!plan) throw new ProblemException('not_found', 'hosting plan not found');
    return {
      id: r.id as string,
      orgId: r.org_id as string,
      status: r.status as string,
      nodeId: r.node_id as string,
      account: r.node_name as string,
      primaryDomain: (r.domain_primary as string | null) ?? null,
      credentialsRef: r.credentials_ref as string,
      runtime: r.runtime as string,
      plan,
    };
  }

  async node(nodeId: string): Promise<ToolNode | null> {
    const r = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM hosting.nodes WHERE id = $1`, [nodeId])).rows[0] as
          Row | undefined,
    );
    if (!r) return null;
    const inv = obj(r.last_inventory);
    const sv = obj(inv.services);
    return {
      id: r.id as string,
      status: r.status as string,
      health: r.health as string,
      panelVersion: (r.panel_version as string | null) ?? null,
      panelHost: (r.panel_host as string | null) ?? null,
      panelConfigured: !!r.panel_host && !!r.panel_key_ref,
      runtimes: Array.isArray(r.runtimes) ? (r.runtimes as string[]) : [],
      services: inv.services
        ? {
            ftp: str(sv.ftp) || null,
            mail: str(sv.mail) || null,
            imap: str(sv.imap) || null,
            webmail: str(sv.webmail) || null,
          }
        : null,
      sftpHostKey: (r.sftp_host_key_sha256 as string | null) ?? null,
    };
  }

  /** A plan limit of a tool: the plan's own key when it has one, else the platform default (a proposal). */
  limit(site: ToolSite, key: keyof ToolsConfig['defaults']): number {
    const v = (site.plan.quotas as unknown as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) && v >= 0
      ? Math.floor(v)
      : this.cfg.defaults[key];
  }

  /** Serializes the mutations of one site: a limit check and the panel call that follows it cannot interleave with another request for the same site. */
  lock<T>(orgId: string, siteId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.withOrg(orgId, async (c) => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `site-tools:${siteId}`,
      ]);
      return fn();
    });
  }

  /** Runs one allow-listed command on the site's node. Success returns the data; a failure becomes a Problem (and an `uncertain` one says so: reconcile before retrying). */
  async run(
    site: ToolSite,
    id: HestiaCommandId,
    values: Record<string, string | undefined>,
  ): Promise<unknown> {
    const r = await this.client.run(site.nodeId, id, values, this.cfg.panelDeadlineMs);
    if (r.ok) return r.data;
    throw this.problem(r);
  }
  /** Like `run` but returns the failure instead of throwing (for the callers that treat a code, e.g. "already exists", as a result). */
  attempt(
    site: ToolSite,
    id: HestiaCommandId,
    values: Record<string, string | undefined>,
  ): Promise<HestiaResult> {
    return this.client.run(site.nodeId, id, values, this.cfg.panelDeadlineMs);
  }

  problem(r: Extract<HestiaResult, { ok: false }>): ProblemException {
    if (r.uncertain)
      return new ProblemException(
        'service_unavailable',
        'the node did not answer: the change may or may not have been applied; check the list and retry',
      );
    switch (r.error.category) {
      case 'not_found':
        return new ProblemException('not_found', 'the item does not exist on the node');
      case 'conflict':
        return new ProblemException('conflict', 'the item already exists or is in use');
      case 'validation':
        return new ProblemException('validation_failed', 'the node refused the value');
      case 'quota':
        return new ProblemException('quota_exceeded', 'the account limit on the node is reached');
      case 'unsupported':
        return new ProblemException(
          'unsupported_capability',
          'this node does not provide that service',
        );
      default:
        // auth (the node connection needs attention), capacity, outage: the customer can only retry later
        return new ProblemException('service_unavailable', 'the node is not available right now');
    }
  }

  /** The domains of the site's own account on the panel: the ONLY domains any tool may act on (another account's domain is not in this list). */
  async domains(site: ToolSite): Promise<string[]> {
    const d = await this.run(site, 'listWebDomains', { user: site.account });
    return Object.keys(obj(d));
  }
  /** `domain` when given, else the primary one; it must be one of the account's own domains. */
  async pickDomain(site: ToolSite, requested?: string): Promise<{ domain: string; all: string[] }> {
    const all = await this.domains(site);
    const domain =
      requested ??
      (site.primaryDomain && all.includes(site.primaryDomain) ? site.primaryDomain : all[0]);
    if (!domain || !all.includes(domain))
      throw new ProblemException('not_found', 'the domain is not part of this site');
    return { domain, all };
  }
}
