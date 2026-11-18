import { createHash } from 'node:crypto';
import {
  CONTRACT_VERSION,
  normalizedError,
  type AccountContext,
  type CapabilityState,
  type EvidenceKind,
  type HealthReport,
  type OperationResult,
  type RawEvidence,
} from './m05-contracts';
import {
  HOSTING_CAPABILITIES,
  type BackupRef,
  type CertRef,
  type CloudPanelTransport,
  type HostingAdapter,
  type HostingCapabilityId,
  type HostingCapabilityReport,
  type NodeRef,
  type NodeState,
  type SiteInfo,
  type SiteRef,
  type SiteSpec,
  type SiteUsage,
  type SiteWipeReport,
  type TransportResponse,
} from './ports';

type Tok = { idempotencyToken: string; operationId: string };

/** `s-` + 20 hex of the idempotency token: the on-node site name IS the reconcile key (findByToken). */
export const siteNameFor = (idempotencyToken: string): string => `s-${idempotencyToken.slice(0, 20)}`;
export const tokenFor = (orgId: string, operationId: string, stepId: string): string =>
  createHash('sha256').update(`${orgId}|${operationId}|${stepId}`).digest('hex');

/**
 * HostingAdapter over a `CloudPanelTransport` (ADR-020: the node agent). It builds NO shell strings and knows no CloudPanel command: it speaks the agent's
 * allow-listed command ids. Capability states come only from the node's `probe`; unknown = unsupported. Evidence is labelled `mock` unless a human-granted
 * live validation sets `evidenceKind: 'live'` (CLAUDE.md §5).
 */
export class CloudPanelHostingAdapter implements HostingAdapter {
  readonly id = 'cloudpanel-agent';
  readonly kind = 'hosting' as const;
  readonly contractVersion = CONTRACT_VERSION;
  constructor(
    private readonly transport: CloudPanelTransport,
    private readonly opts: { evidenceKind?: EvidenceKind; now?: () => Date } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }
  private ev(operation: string, r: TransportResponse): RawEvidence {
    return { kind: this.opts.evidenceKind ?? 'mock', capturedAt: this.now().toISOString(), operation, summary: r.rawSummary };
  }
  private async call(ctx: AccountContext, node: NodeRef, commandId: string, args: Record<string, unknown>, t: Tok) {
    return this.transport.send({ nodeId: node.nodeId, commandId, args, operationId: t.operationId, idempotencyToken: t.idempotencyToken, deadlineMs: ctx.deadlineMs });
  }
  private result<T>(op: string, r: TransportResponse, map: (x: unknown) => T): OperationResult<T> {
    const raw = this.ev(op, r);
    if (r.status === 'ok') return { status: 'succeeded', data: map(r.result), raw };
    if (r.status === 'uncertain') return { status: 'uncertain', raw };
    if (r.status === 'rejected') {
      const cat = r.reason === 'invalid_args' ? 'validation' : r.reason === 'unknown_command' ? 'unsupported' : 'auth';
      return { status: 'failed', error: normalizedError(cat, `agent_${r.reason ?? 'rejected'}`, 'the node agent rejected the command'), raw };
    }
    const cat = (['validation', 'not_found', 'conflict', 'unsupported', 'capacity'] as const).find((c) => c === r.reason) ?? 'unknown';
    return { status: 'failed', error: normalizedError(cat, `node_${r.reason ?? 'failed'}`, typeof r.result === 'string' ? r.result : 'the node reported a failure'), raw };
  }
  private readonly readTok = (ctx: AccountContext): Tok => ({ idempotencyToken: tokenFor('read', ctx.traceId, 'read'), operationId: ctx.traceId });

  async probe(ctx: AccountContext, node: NodeRef): Promise<HostingCapabilityReport> {
    const r = await this.call(ctx, node, 'probe', {}, this.readTok(ctx));
    const all = Object.fromEntries(HOSTING_CAPABILITIES.map((c) => [c, 'unknown'])) as Record<HostingCapabilityId, CapabilityState>;
    let runtimes: string[] = [];
    if (r.status === 'ok') {
      const d = r.result as { runtimes?: string[]; capabilities?: string[] };
      runtimes = Array.isArray(d.runtimes) ? d.runtimes.filter((x) => typeof x === 'string') : [];
      for (const c of d.capabilities ?? []) if ((HOSTING_CAPABILITIES as readonly string[]).includes(c)) all[c as HostingCapabilityId] = 'supported';
      // a capability the probe did not report stays `unknown` (= unsupported); a reachable node that omitted it is `unsupported`
      for (const c of HOSTING_CAPABILITIES) if (all[c] === 'unknown' && !c.startsWith('hosting.runtime.')) all[c] = 'unsupported';
      for (const kind of ['php', 'nodejs', 'python']) all[`hosting.runtime.${kind}` as HostingCapabilityId] = runtimes.some((x) => x.startsWith(kind + ':')) ? 'supported' : 'unsupported';
      all['hosting.runtime.static'] = runtimes.includes('static') ? 'supported' : 'unsupported';
      all['hosting.runtime.reverse-proxy'] = runtimes.includes('reverse-proxy') ? 'supported' : 'unsupported';
    }
    return { capabilities: all, runtimes, probedAt: this.now().toISOString(), evidence: [this.ev('probe', r)] };
  }
  async health(ctx: AccountContext, node: NodeRef): Promise<HealthReport> {
    const inv = await this.inventory(ctx, node);
    if (inv.status !== 'succeeded' || !inv.data) return { state: inv.status === 'uncertain' ? 'unknown' : 'unhealthy', checkedAt: this.now().toISOString(), evidence: [inv.raw] };
    return inv.data.health;
  }
  async inventory(ctx: AccountContext, node: NodeRef): Promise<OperationResult<NodeState>> {
    const r = await this.call(ctx, node, 'inventory', {}, this.readTok(ctx));
    return this.result('inventory', r, (x) => {
      const d = x as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- agent reply is validated field by field below
      const health: HealthReport = { state: d.health === 'healthy' || d.health === 'degraded' || d.health === 'unhealthy' ? d.health : 'unknown', checkedAt: this.now().toISOString() };
      return {
        observedAt: this.now().toISOString(),
        cloudpanelVersion: typeof d.cloudpanelVersion === 'string' ? d.cloudpanelVersion : null,
        clpctlVersion: typeof d.clpctlVersion === 'string' ? d.clpctlVersion : null,
        agentVersion: String(d.agentVersion ?? 'unknown'),
        health,
        capacity: { cpuMillicores: Number(d.capacity?.cpuMillicores ?? 0), memoryMb: Number(d.capacity?.memoryMb ?? 0), diskMb: Number(d.capacity?.diskMb ?? 0) },
        usage: { loadAvg1: Number(d.loadAvg1 ?? 0), memoryUsedMb: Number(d.memoryUsedMb ?? 0), diskUsedMb: Number(d.diskUsedMb ?? 0), sites: Number(d.sites ?? 0) },
        runtimes: Array.isArray(d.runtimes) ? d.runtimes.map(String) : [],
      };
    });
  }
  async createSite(ctx: AccountContext, node: NodeRef, spec: SiteSpec & Tok): Promise<OperationResult<SiteRef>> {
    const r = await this.call(ctx, node, 'site.create', { site: spec.name, runtime: spec.runtime, domain: spec.domain, limits: spec.limits, credentialsRef: spec.credentialsRef, backupKeyRef: spec.backupKeyRef }, spec);
    return this.result('createSite', r, (x) => x as SiteRef);
  }
  async findByToken(ctx: AccountContext, node: NodeRef, siteName: string): Promise<OperationResult<SiteInfo | null>> {
    const r = await this.call(ctx, node, 'site.find', { site: siteName }, this.readTok(ctx));
    return this.result('findByToken', r, (x) => (x as SiteInfo | null) ?? null);
  }
  async updateSite(ctx: AccountContext, node: NodeRef, siteName: string, patch: { limits?: SiteSpec['limits']; runtime?: string; domains?: string[] }, t: Tok): Promise<OperationResult<SiteInfo>> {
    const r = await this.call(ctx, node, 'site.update', { site: siteName, ...(patch.limits ? { limits: patch.limits } : {}), ...(patch.runtime ? { runtime: patch.runtime } : {}) }, t);
    return this.result('updateSite', r, (x) => x as SiteInfo);
  }
  async suspendSite(ctx: AccountContext, node: NodeRef, siteName: string, t: Tok): Promise<OperationResult<void>> {
    return this.result('suspendSite', await this.call(ctx, node, 'site.suspend', { site: siteName }, t), () => undefined);
  }
  async resumeSite(ctx: AccountContext, node: NodeRef, siteName: string, t: Tok): Promise<OperationResult<void>> {
    return this.result('resumeSite', await this.call(ctx, node, 'site.resume', { site: siteName }, t), () => undefined);
  }
  async deleteSite(ctx: AccountContext, node: NodeRef, siteName: string, t: Tok): Promise<OperationResult<SiteWipeReport>> {
    return this.result('deleteSite', await this.call(ctx, node, 'site.delete', { site: siteName }, t), (x) => x as SiteWipeReport);
  }
  async issueCertificate(ctx: AccountContext, node: NodeRef, siteName: string, req: { domains: string[]; mode: 'managed' | 'custom'; customCertRef?: string }, t: Tok): Promise<OperationResult<CertRef>> {
    const bind = async () => { for (const d of req.domains) { const b = await this.call(ctx, node, 'domain.bind', { site: siteName, domain: d }, { ...t, idempotencyToken: tokenFor(t.idempotencyToken, d, 'bind') }); if (b.status !== 'ok') return b; } return null; };
    const failed = await bind();
    if (failed) return this.result('issueCertificate', failed, () => undefined as never);
    const r = req.mode === 'custom'
      ? await this.call(ctx, node, 'cert.install', { site: siteName, domains: req.domains, certRef: req.customCertRef }, t)
      : await this.call(ctx, node, 'cert.issue', { site: siteName, domains: req.domains }, t);
    return this.result('issueCertificate', r, (x) => x as CertRef);
  }
  async backup(ctx: AccountContext, node: NodeRef, siteName: string, t: Tok & { backupId?: string }): Promise<OperationResult<BackupRef>> {
    const backupId = t.backupId ?? uuidFromToken(t.idempotencyToken);
    return this.result('backup', await this.call(ctx, node, 'backup.create', { site: siteName, backupId }, t), (x) => x as BackupRef);
  }
  async restore(ctx: AccountContext, node: NodeRef, siteName: string, b: BackupRef, t: Tok): Promise<OperationResult<{ verified: boolean; checksum: string }>> {
    return this.result('restore', await this.call(ctx, node, 'backup.restore', { site: siteName, backupId: b.backupId, checksum: b.checksum }, t), (x) => x as { verified: boolean; checksum: string });
  }
  async usage(ctx: AccountContext, node: NodeRef, siteName: string): Promise<OperationResult<SiteUsage>> {
    return this.result('usage', await this.call(ctx, node, 'usage.report', { site: siteName }, this.readTok(ctx)), (x) => x as SiteUsage);
  }
}

/** A stable UUID-shaped id derived from a token (backup ids must match the agent schema). */
export function uuidFromToken(token: string): string {
  const h = createHash('sha256').update('backup|' + token).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
