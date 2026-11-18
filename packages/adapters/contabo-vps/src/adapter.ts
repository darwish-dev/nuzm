import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  actionCapability,
  completeCapabilities,
  isSupported,
  normalizedError,
  orgTag,
  type AccountContext,
  type CapabilityId,
  type CapabilityReport,
  type CapabilityState,
  type CatalogSnapshot,
  type ComputeAction,
  type ComputeAdapter,
  type ErrorCategory,
  type EvidenceKind,
  type HealthReport,
  type InstanceRef,
  type InstanceState,
  type InstanceStatus,
  type OperationResult,
  type ProviderImage,
  type ProviderPlan,
  type ProviderQuote,
  type ProviderRegion,
  type ProvisionRequest,
  type RawEvidence,
  type Redactor,
  type VaultClient,
} from '@nuzm/adapter-contracts';
import {
  ProbeCache,
  TransportAmbiguousError,
  makeEvidence,
  opFail,
  opFailCat,
  opOk,
  opUncertain,
  opUnsupported,
  weakest,
  type HttpResponse,
  type HttpTransport,
} from '@nuzm/adapter-http';
import {
  CONTABO_PRODUCTS,
  CONTABO_REGION_COUNTRY,
  CONTABO_REGION_ENUM,
  productById,
  snapshotsDocumented,
} from './products';

/**
 * `contabo-vps` — Contabo VPS/VDS compute adapter, built ONLY from the official API reference (https://api.contabo.com/, read
 * 2026-11-18; see README for every cited page). Everything here is NOT VERIFIED against a real account (HG-05-03 pending).
 *
 * Honest limits of the documented API, and what the adapter does about them:
 *  - no idempotency key (x-request-id is for support correlation only) → the adapter looks the token up (displayName marker) BEFORE any
 *    create and `findByToken` searches the same marker; the residual race and listing consistency are NOT DOCUMENTED (README, S22 report);
 *  - no product list, no prices, no per-product region availability → plans are listed only where the docs give a COMPLETE spec and are
 *    `unavailable` with no price (never offered) until availability and a Nuzm price are established elsewhere;
 *  - no DELETE: an instance is ended with `cancel` (cancelDate); semantics after cancel are NOT DOCUMENTED;
 *  - no billing/usage API → no `fetchBilling` (manual import path in S23); no metrics API → no `metrics`; no documented in-place resize.
 */
export const CONTABO_API_BASE = 'https://api.contabo.com';
export const CONTABO_TOKEN_URL =
  'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token';

export interface ContaboOptions {
  vault: VaultClient;
  redactor: Redactor;
  transport: HttpTransport;
  now?: () => number;
  apiBase?: string;
  tokenUrl?: string;
  /**
   * `read-only` (default, the only mode allowed against a real account): a capability is `supported` only when a read-only call proved it;
   * everything that would need a mutation to prove is `unknown` (= unsupported) until a human-triggered live verification.
   * `documented`: FIXTURE RUNS ONLY — mutating capabilities the official docs describe are reported `supported` so the conformance kit can
   * exercise them against a simulator. Refused for live endpoints (evidence kind `live`).
   */
  capabilityMode?: 'read-only' | 'documented';
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- vendor JSON is untyped until narrowed below
interface Reply {
  status: number; // 0 = no usable answer
  json: Json | null;
  ambiguous: string | null;
  ev: RawEvidence;
}

const TOKEN_TTL_MS = 60_000; // token lifetime is NOT DOCUMENTED: never reuse a token for longer than a minute
const MARKER = 'nuzm:';

export function categoryForStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'quota';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'provider_outage';
  if (status === 400 || status === 415 || status === 422) return 'validation';
  return 'unknown';
}

export class ContaboVpsAdapter implements ComputeAdapter {
  readonly id = 'contabo-vps';
  readonly kind = 'compute' as const;
  readonly contractVersion = CONTRACT_VERSION;
  /** Exposed for tests/the live-verification runner: the last probe per account. */
  readonly probeCache = new ProbeCache();
  private readonly now: () => number;
  private readonly apiBase: string;
  private readonly tokenUrl: string;
  private readonly mode: 'read-only' | 'documented';
  private readonly tokens = new Map<string, { token: string; at: number }>();

  constructor(private readonly o: ContaboOptions) {
    this.now = o.now ?? Date.now;
    this.apiBase = (o.apiBase ?? CONTABO_API_BASE).replace(/\/$/, '');
    this.tokenUrl = o.tokenUrl ?? CONTABO_TOKEN_URL;
    this.mode = o.capabilityMode ?? 'read-only';
  }

  // ---- plumbing -----------------------------------------------------------------------------------------------------------
  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private ev(
    kind: EvidenceKind,
    op: string,
    summary: string,
    req?: unknown,
    res?: unknown,
  ): RawEvidence {
    return makeEvidence(this.o.redactor, kind, this.iso(), op, summary, req, res);
  }
  private kindFor(url: string): EvidenceKind {
    return this.o.transport.evidenceKind(url);
  }

  private async accessToken(ctx: AccountContext): Promise<{ token: string } | { fail: Reply }> {
    const hit = this.tokens.get(ctx.providerAccountId);
    if (hit && this.now() - hit.at < TOKEN_TTL_MS) return { token: hit.token };
    const material = await this.o.vault.resolve(ctx.credentialRef);
    this.o.redactor.register(material);
    const f = material.fields;
    const need = ['clientId', 'clientSecret', 'apiUser', 'apiPassword'] as const;
    const kind = this.kindFor(this.tokenUrl);
    if (need.some((k) => !f[k]))
      return {
        fail: {
          status: 401,
          json: null,
          ambiguous: null,
          ev: this.ev(
            kind,
            'auth',
            'credential material lacks one of clientId, clientSecret, apiUser, apiPassword',
          ),
        },
      };
    const body = new URLSearchParams({
      client_id: f.clientId!,
      client_secret: f.clientSecret!,
      username: f.apiUser!,
      password: f.apiPassword!,
      grant_type: 'password',
    }).toString();
    let res: HttpResponse;
    try {
      res = await this.o.transport.send({
        method: 'POST',
        url: this.tokenUrl,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        timeoutMs: ctx.deadlineMs,
      });
    } catch (e) {
      return {
        fail: {
          status: 0,
          json: null,
          ambiguous: (e as Error).message,
          ev: this.ev(kind, 'auth', `token request failed: ${(e as Error).message}`),
        },
      };
    }
    let json: Json | null = null;
    try {
      json = JSON.parse(res.body) as Json;
    } catch {
      /* not JSON */
    }
    const token = typeof json?.access_token === 'string' ? json.access_token : null;
    if (res.status >= 200 && res.status < 300 && token) {
      this.o.redactor.register(token);
      this.tokens.set(ctx.providerAccountId, { token, at: this.now() });
      return { token };
    }
    return {
      fail: {
        status: res.status || 401,
        json,
        ambiguous: null,
        ev: this.ev(kind, 'auth', `token endpoint answered HTTP ${res.status}`, undefined, {
          status: res.status,
        }),
      },
    };
  }

  /** One authenticated API call. Never throws for provider/transport problems: ambiguity is reported in `Reply.ambiguous`. */
  private async call(
    ctx: AccountContext,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; op: string },
  ): Promise<Reply> {
    const url = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const kind = this.kindFor(url.toString());
    if (this.mode === 'documented' && kind === 'live')
      throw new Error(
        'capabilityMode "documented" is for fixture runs only and is refused for live endpoints',
      );
    const t = await this.accessToken(ctx);
    if ('fail' in t) return t.fail;
    const send = (token: string) =>
      this.o.transport.send({
        method,
        url: url.toString(),
        headers: {
          authorization: `Bearer ${token}`,
          'x-request-id': randomUUID(),
          'content-type': 'application/json',
          'x-trace-id': ctx.traceId.slice(0, 64),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        timeoutMs: ctx.deadlineMs,
      });
    let res: HttpResponse;
    try {
      res = await send(t.token);
      if (res.status === 401) {
        // token may have expired (lifetime NOT DOCUMENTED): refresh once. A 401 means the request was refused, so a repeat is safe.
        this.tokens.delete(ctx.providerAccountId);
        const t2 = await this.accessToken(ctx);
        if ('fail' in t2) return t2.fail;
        res = await send(t2.token);
      }
    } catch (e) {
      if (e instanceof TransportAmbiguousError || (e as Error).name === 'AdapterTimeoutError')
        return {
          status: 0,
          json: null,
          ambiguous: (e as Error).message,
          ev: this.ev(kind, opts.op, `${method} ${path}: ${(e as Error).message}`),
        };
      throw e;
    }
    let json: Json | null = null;
    try {
      json = res.body ? (JSON.parse(res.body) as Json) : null;
    } catch {
      /* non-JSON error page */
    }
    return {
      status: res.status,
      json,
      ambiguous: null,
      ev: this.ev(
        kind,
        opts.op,
        `${method} ${path} -> HTTP ${res.status}`,
        { method, path, query: opts.query },
        { status: res.status },
      ),
    };
  }

  private failFrom<T>(r: Reply): OperationResult<T> {
    const cat = categoryForStatus(r.status);
    const msg =
      typeof r.json?.message === 'string' ? (r.json.message as string) : `HTTP ${r.status}`;
    return opFail(r.ev, normalizedError(cat, `http_${r.status}`, msg));
  }
  /** A failed read: a transport problem is an outage, not an unknown effect. */
  private readFail<T>(r: Reply): OperationResult<T> {
    if (r.ambiguous)
      return opFail(r.ev, normalizedError('provider_outage', 'timeout', r.ambiguous, true));
    return this.failFrom<T>(r);
  }
  /** A failed MUTATION: transport ambiguity and 5xx may have had an effect → `uncertain`. */
  private mutFail<T>(r: Reply): OperationResult<T> {
    if (r.ambiguous) return opUncertain(r.ev, r.ambiguous);
    if (r.status >= 500) return opUncertain(r.ev, `provider answered HTTP ${r.status}`);
    return this.failFrom<T>(r);
  }
  private ok2xx = (r: Reply) => r.status >= 200 && r.status < 300;

  // ---- AdapterBase --------------------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext): Promise<CapabilityReport> {
    const evidence: RawEvidence[] = [];
    const list = await this.call(ctx, 'GET', '/v1/compute/instances', {
      query: { size: '1' },
      op: 'probe.listInstances',
    });
    evidence.push(list.ev);
    const lookup = await this.call(ctx, 'GET', '/v1/compute/instances', {
      query: { size: '1', search: `${MARKER}probe` },
      op: 'probe.lookupBySearch',
    });
    evidence.push(lookup.ev);
    const dc = await this.call(ctx, 'GET', '/v1/data-centers', {
      query: { size: '1' },
      op: 'probe.dataCenters',
    });
    evidence.push(dc.ev);

    const caps: Partial<Record<CapabilityId, CapabilityState>> = {};
    const readable = this.ok2xx(list);
    caps['compute.inspect'] = readable ? 'supported' : 'unknown';
    caps['compute.find-by-token'] = this.ok2xx(lookup) ? 'supported' : 'unknown';
    // documented as NOT existing in the API reference we read: unsupported (not merely unknown)
    caps['compute.metrics'] = 'unsupported';
    caps['compute.billing-export'] = 'unsupported';
    caps['compute.quote-api'] = 'unsupported';
    caps['compute.action.resize'] = 'unsupported'; // no documented in-place plan change (upgrade = add-ons only)
    // mutating capabilities cannot be proven by a read-only call: unknown (= unsupported) until live verification (HG-05-03)
    const docMut: CapabilityState =
      this.mode === 'documented' && readable ? 'supported' : 'unknown';
    for (const id of [
      'compute.provision',
      'compute.delete',
      'compute.action.start',
      'compute.action.stop',
      'compute.action.reboot',
      'compute.action.snapshot',
    ] as const)
      caps[id] = docMut;
    const report: CapabilityReport = {
      capabilities: completeCapabilities(caps),
      evidence,
      probedAt: this.iso(),
    };
    this.probeCache.set(ctx.providerAccountId, report);
    return report;
  }

  async health(ctx: AccountContext): Promise<HealthReport> {
    const t0 = this.now();
    const r = await this.call(ctx, 'GET', '/v1/compute/instances', {
      query: { size: '1' },
      op: 'health',
    });
    const latencyMs = this.now() - t0;
    const state = this.ok2xx(r)
      ? 'healthy'
      : r.status === 429
        ? 'degraded'
        : r.status === 401 || r.status === 403
          ? 'unhealthy'
          : r.ambiguous || r.status >= 500
            ? 'unhealthy'
            : 'unknown';
    return {
      state,
      checkedAt: this.iso(),
      latencyMs,
      detail: r.ambiguous ?? `HTTP ${r.status}`,
      evidence: [r.ev],
    };
  }

  async listRegions(ctx: AccountContext): Promise<ProviderRegion[]> {
    const items: Json[] = [];
    const evidence: RawEvidence[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.call(ctx, 'GET', '/v1/data-centers', {
        query: { page: String(page), size: '100' },
        op: 'listRegions',
      });
      evidence.push(r.ev);
      if (!this.ok2xx(r)) throw new Error(`data-centers listing failed: HTTP ${r.status}`);
      const data = Array.isArray(r.json?.data) ? (r.json!.data as Json[]) : [];
      items.push(...data);
      const total = Number(r.json?._pagination?.totalPages ?? 1);
      if (page >= total) break;
    }
    const kind = weakest(evidence);
    const bySlug = new Map<string, Json[]>();
    for (const dc of items) {
      const caps: unknown = dc.capabilities;
      if (Array.isArray(caps) && !caps.includes('VPS')) continue; // only data centres documented as offering VPS
      const slug = String(dc.regionSlug ?? '');
      if (!(CONTABO_REGION_ENUM as readonly string[]).includes(slug)) continue; // unknown to the create-request enum = unsupported
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), dc]);
    }
    return [...bySlug.entries()].map(([slug, dcs]) => ({
      providerRegionId: slug,
      countryCode: CONTABO_REGION_COUNTRY[slug]!,
      displayName: String(dcs[0]?.regionName ?? slug),
      // "verified" means observed in the account's own listing AND the observation is live evidence. Fixture runs never verify.
      verifiedAt: kind === 'live' ? this.iso() : null,
      evidence: [
        this.ev(
          kind,
          'listRegions',
          `region ${slug} listed by GET /v1/data-centers (${dcs.length} data centre(s))`,
          undefined,
          { dataCenters: dcs.map((d) => d.slug) },
        ),
      ],
    }));
  }

  async listPlans(_ctx: AccountContext, region: string): Promise<ProviderPlan[]> {
    if (!(CONTABO_REGION_ENUM as readonly string[]).includes(region)) return [];
    // Only products whose spec is COMPLETE in the docs. Availability per region/product and prices are NOT DOCUMENTED: `unavailable`,
    // no price → the offer eligibility function never shows them until both are established (S22 report, D-23).
    return CONTABO_PRODUCTS.filter((p) => p.vcpu && p.memoryGb).map((p) => ({
      planRef: p.productId,
      providerRegionId: region,
      vcpu: p.vcpu!,
      memoryMb: p.memoryGb! * 1024,
      diskGb: p.diskGb,
      bandwidth: p.bandwidthMbit ? `${p.bandwidthMbit} Mbit/s` : undefined,
      availability: 'unavailable' as const,
    }));
  }

  async listImages(ctx: AccountContext, region: string): Promise<ProviderImage[]> {
    const r = await this.call(ctx, 'GET', '/v1/compute/images', {
      query: { size: '100', standardImage: 'true' },
      op: 'listImages',
    });
    if (!this.ok2xx(r)) throw new Error(`images listing failed: HTTP ${r.status}`);
    return (Array.isArray(r.json?.data) ? (r.json!.data as Json[]) : []).map((i) => ({
      imageRef: String(i.imageId),
      providerRegionId: region, // images are account-wide in the API (NOT DOCUMENTED per region)
      name: String(i.name ?? i.imageId),
      ...(typeof i.osType === 'string' ? { osFamily: (i.osType as string).toLowerCase() } : {}),
    }));
  }

  async catalog(ctx: AccountContext): Promise<CatalogSnapshot> {
    const regions = await this.listRegions(ctx);
    const plans: ProviderPlan[] = [];
    for (const r of regions) plans.push(...(await this.listPlans(ctx, r.providerRegionId)));
    const first = regions[0]?.providerRegionId ?? 'EU';
    const images = await this.listImages(ctx, first);
    const evidence = regions.flatMap((r) => r.evidence);
    return { takenAt: this.iso(), regions, plans, images, evidence };
  }

  async quote(_ctx: AccountContext, req: ProvisionRequest): Promise<ProviderQuote> {
    return {
      planRef: req.planRef,
      providerRegionId: req.providerRegionId,
      price: null, // no price source in the documented API
      derivedFromCatalog: true,
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------------
  private caps(ctx: AccountContext): Promise<Record<CapabilityId, CapabilityState>> {
    const hit = this.probeCache.get(ctx.providerAccountId);
    if (hit) return Promise.resolve(hit);
    return this.probe(ctx).then((r) => r.capabilities);
  }
  private markerName(token: string, name: string): string {
    return `${MARKER}${token}|${name}`.slice(0, 255);
  }
  private evNow(op: string, summary: string, kind: EvidenceKind = 'fixture'): RawEvidence {
    return this.ev(kind, op, summary);
  }
  private refOf(i: Json): string {
    return String(i.instanceId);
  }

  private async lookup(
    ctx: AccountContext,
    token: string,
  ): Promise<Reply & { found: Json | null }> {
    const r = await this.call(ctx, 'GET', '/v1/compute/instances', {
      query: { search: `${MARKER}${token}`, size: '10' },
      op: 'findByToken',
    });
    const data = Array.isArray(r.json?.data) ? (r.json!.data as Json[]) : [];
    const found =
      data.find(
        (i) =>
          typeof i.displayName === 'string' &&
          (i.displayName as string).startsWith(`${MARKER}${token}|`),
      ) ?? null;
    return Object.assign(r, { found });
  }

  async provision(
    ctx: AccountContext,
    req: ProvisionRequest & { idempotencyToken: string },
  ): Promise<OperationResult<InstanceRef>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.provision'))
      return opUnsupported(this.evNow('provision', 'provision not supported'), 'compute.provision');
    if (!(CONTABO_REGION_ENUM as readonly string[]).includes(req.providerRegionId))
      return opFailCat(
        this.evNow('provision', 'unknown region'),
        'validation',
        'invalid_region',
        `region ${req.providerRegionId} is not in the documented region enum`,
      );
    if (!productById(req.planRef))
      return opFailCat(
        this.evNow('provision', 'unknown product'),
        'validation',
        'invalid_product',
        `product ${req.planRef} is not in the documented product table (unknown = unsupported)`,
      );
    // No vendor idempotency: look the token up first (and never create when it is already there).
    if (isSupported(caps, 'compute.find-by-token')) {
      const pre = await this.lookup(ctx, req.idempotencyToken);
      if (pre.ambiguous) return opUncertain(pre.ev, 'pre-create lookup did not answer');
      if (!this.ok2xx(pre)) return this.readFail(pre);
      if (pre.found)
        return opOk(
          pre.ev,
          { providerRef: this.refOf(pre.found) },
          this.refOf(pre.found),
          'accepted',
        );
    }
    const body: Json = {
      productId: req.planRef,
      region: req.providerRegionId,
      imageId: req.imageRef,
      period: 1, // documented values 1, 12, 24 (months): the shortest commitment
      displayName: this.markerName(
        req.idempotencyToken,
        `${req.name}|${req.tags['nuzm-org'] ?? orgTag('unknown')}`,
      ),
      defaultUser: 'admin',
      // SSH keys: the documented `sshKeys` field takes Secrets-API ids, whose endpoints we could not read (NOT VERIFIED). cloud-init
      // `userData` IS documented as a create field, so keys are injected through it.
      ...(req.sshPublicKeys.length
        ? {
            userData: `#cloud-config\nssh_authorized_keys:\n${req.sshPublicKeys.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\n`,
          }
        : {}),
    };
    const r = await this.call(ctx, 'POST', '/v1/compute/instances', { body, op: 'provision' });
    if (!this.ok2xx(r)) return this.mutFail(r);
    const first = Array.isArray(r.json?.data) ? (r.json!.data as Json[])[0] : undefined;
    if (!first || first.instanceId === undefined)
      return opUncertain(r.ev, 'create answered 2xx without an instanceId');
    return opOk(r.ev, { providerRef: this.refOf(first) }, this.refOf(first), 'accepted');
  }

  private mapStatus(s: unknown): InstanceStatus {
    switch (s) {
      case 'running':
      case 'rescue': // booted into the rescue system: reachable (documented as a live system)
        return 'running';
      case 'stopped':
        return 'stopped';
      case 'provisioning':
      case 'installing':
      case 'manual_provisioning':
      case 'pending_payment':
      case 'verification_required':
      case 'reset_password':
        return 'provisioning';
      default:
        return 'error'; // error, unknown, other, uninstalled, product_not_available, or anything undocumented
    }
  }

  private validRef(ref: string): boolean {
    return /^\d{1,18}$/.test(ref);
  }

  async inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceState>> {
    if (!this.validRef(ref))
      return opFailCat(
        this.evNow('inspect', 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Contabo instance id',
      );
    const r = await this.call(ctx, 'GET', `/v1/compute/instances/${ref}`, { op: 'inspect' });
    if (r.status === 404) return opFailCat(r.ev, 'not_found', 'http_404', 'instance not found');
    if (!this.ok2xx(r)) return this.readFail(r);
    const i = (Array.isArray(r.json?.data) ? (r.json!.data as Json[])[0] : undefined) ?? {};
    const cancel = typeof i.cancelDate === 'string' ? Date.parse(i.cancelDate as string) : NaN;
    let status = this.mapStatus(i.status);
    if (!Number.isNaN(cancel)) status = cancel <= this.now() ? 'deleted' : 'deleting';
    const ips: string[] = [];
    const v4 = i.ipConfig?.v4?.ip;
    const v6 = i.ipConfig?.v6?.ip;
    if (typeof v4 === 'string') ips.push(v4);
    if (typeof v6 === 'string') ips.push(v6);
    return opOk(
      r.ev,
      {
        providerRef: ref,
        status,
        providerRegionId: String(i.region ?? ''),
        planRef: String(i.productId ?? ''),
        publicIps: ips,
        tags: {}, // instances carry no tags in the documented object; the token lives in displayName
        observedAt: this.iso(),
      },
      ref,
    );
  }

  async findByToken(
    ctx: AccountContext,
    token: string,
  ): Promise<OperationResult<InstanceRef | null>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.find-by-token'))
      return opUnsupported(
        this.evNow('findByToken', 'lookup not supported'),
        'compute.find-by-token',
      );
    const r = await this.lookup(ctx, token);
    if (r.ambiguous)
      return opFail(r.ev, normalizedError('provider_outage', 'timeout', r.ambiguous, true));
    if (!this.ok2xx(r)) return this.readFail(r);
    return opOk(
      r.ev,
      r.found ? { providerRef: this.refOf(r.found) } : null,
      r.found ? this.refOf(r.found) : undefined,
    );
  }

  async act(
    ctx: AccountContext,
    ref: string,
    action: ComputeAction,
    _params: Record<string, unknown>,
  ): Promise<OperationResult<void>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, actionCapability(action)))
      return opUnsupported(
        this.evNow(`act.${action}`, `${action} not supported`),
        `compute.action.${action}`,
      );
    if (!this.validRef(ref))
      return opFailCat(
        this.evNow(`act.${action}`, 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Contabo instance id',
      );
    if (action === 'snapshot') {
      // plan-specific detection: docs.contabo.com lists snapshots only for Cloud VPS / Cloud VPS Plus
      const cur = await this.inspect(ctx, ref);
      if (cur.status !== 'succeeded') return cur as unknown as OperationResult<void>;
      if (!snapshotsDocumented(cur.data!.planRef))
        return opUnsupported(
          cur.raw,
          `snapshots for product ${cur.data!.planRef} (documented only for Cloud VPS and Cloud VPS Plus)`,
        );
      const name = `nz-${Math.floor(this.now() / 1000)}`.slice(0, 30);
      const r = await this.call(ctx, 'POST', `/v1/compute/instances/${ref}/snapshots`, {
        body: { name },
        op: 'act.snapshot',
      });
      return this.ok2xx(r) ? opOk<void>(r.ev, undefined, ref, 'accepted') : this.mutFail(r);
    }
    const path = { start: 'start', stop: 'stop', reboot: 'restart' }[
      action as 'start' | 'stop' | 'reboot'
    ];
    if (!path)
      return opUnsupported(
        this.evNow(`act.${action}`, 'no documented endpoint'),
        `compute.action.${action}`,
      );
    const r = await this.call(ctx, 'POST', `/v1/compute/instances/${ref}/actions/${path}`, {
      op: `act.${action}`,
    });
    if (r.status === 404) return opFailCat(r.ev, 'not_found', 'http_404', 'instance not found');
    return this.ok2xx(r) ? opOk<void>(r.ev, undefined, ref, 'accepted') : this.mutFail(r);
  }

  /** Contabo has no DELETE: the instance is cancelled (documented `cancel` with `cancelDate`). Idempotent: an instance already cancelled/gone succeeds. */
  async delete(ctx: AccountContext, ref: string): Promise<OperationResult<void>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.delete'))
      return opUnsupported(this.evNow('delete', 'delete not supported'), 'compute.delete');
    if (!this.validRef(ref))
      return opFailCat(
        this.evNow('delete', 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Contabo instance id',
      );
    const cur = await this.call(ctx, 'GET', `/v1/compute/instances/${ref}`, {
      op: 'delete.inspect',
    });
    if (cur.status === 404) return opOk<void>(cur.ev, undefined, ref);
    if (!this.ok2xx(cur))
      return cur.ambiguous ? opUncertain(cur.ev, cur.ambiguous) : this.mutFail(cur);
    const i = (Array.isArray(cur.json?.data) ? (cur.json!.data as Json[])[0] : undefined) ?? {};
    if (typeof i.cancelDate === 'string' && i.cancelDate) return opOk<void>(cur.ev, undefined, ref);
    const cancelDate = new Date(this.now()).toISOString().slice(0, 10);
    const r = await this.call(ctx, 'POST', `/v1/compute/instances/${ref}/cancel`, {
      body: { cancelDate },
      op: 'delete.cancel',
    });
    if (r.status === 404) return opOk<void>(r.ev, undefined, ref);
    return this.ok2xx(r) ? opOk<void>(r.ev, undefined, ref) : this.mutFail(r);
  }
}
