import { createHash } from 'node:crypto';
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
  type Metrics,
  type OperationResult,
  type PlanAvailability,
  type ProviderCostRecord,
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
  type HttpTransport,
} from '@nuzm/adapter-http';
import { sdkDate, signSdkHmacSha256 } from './signer';

/**
 * `huawei-ecs` — Huawei Cloud ECS adapter built ONLY from the official documentation (see README for every page and the date read).
 * NOT VERIFIED against any account: HG-05-02 is PENDING and no call to Huawei was ever made.
 *
 * Documentation facts that shape it:
 *  - `X-Client-Token` (a UUID, valid 8 hours) makes Create ECSs idempotent. Servers cannot be looked up by client token, and the `tags=`
 *    filter syntax of the list API is NOT DOCUMENTED, so the idempotency token is ALSO embedded in the server NAME (`nz-<token>-…`, the
 *    documented fuzzy `name` filter) and `findByToken` filters client-side. A replay after the 8-hour window (`Ecs.0124`) therefore does a
 *    lookup first and never creates blindly.
 *  - ECS has no snapshot API: a snapshot is an EVS (disk) snapshot (`/v2/{project_id}/cloudsnapshots`).
 *  - Create/start/stop/reboot/resize/delete are asynchronous jobs; they return `accepted`, the orchestrator inspects.
 *  - No documented DryRun-style proof for start/stop/reboot/resize/delete/snapshot, and the `dry_run` flag of Create is not used by the
 *    probe (a mis-honoured flag would create a billable server): every mutating capability is `unknown` (= unsupported) in `read-only`
 *    mode until a human-triggered live verification.
 */
export const defaultEndpoint = (service: string, region: string): string =>
  service === 'bss'
    ? 'https://bss-intl.myhuaweicloud.com'
    : `https://${service}.${region}.myhuaweicloud.com`;

/**
 * Region → country, derived from the region NAMES in the API Explorer endpoint table
 * (https://console-intl.huaweicloud.com/apiexplorer/#/endpoint/ECS, read 2026-11-18: "ME-Riyadh | me-east-1", "ME-Abu Dhabi-OP5 | ae-ad-1",
 * "AP-Singapore | ap-southeast-3", "CN-Hong Kong | ap-southeast-1", "EU-Paris | eu-west-0", "EU-Dublin | eu-west-101", …).
 * A region not in this table (or in `countryByRegion`) is skipped: unknown = unsupported. Mainland-China regions are intentionally absent.
 */
export const DOCUMENTED_REGION_COUNTRY: Record<string, string> = {
  'me-east-1': 'SA',
  'ae-ad-1': 'AE',
  'ap-southeast-1': 'HK',
  'ap-southeast-3': 'SG',
  'eu-west-0': 'FR',
  'eu-west-101': 'IE',
  'af-south-1': 'ZA',
  'af-north-1': 'EG',
  'tr-west-1': 'TR',
};

export interface HuaweiNetwork {
  vpcId: string;
  subnetId: string;
  securityGroupId: string;
  availabilityZone?: string;
}
export interface HuaweiOptions {
  vault: VaultClient;
  redactor: Redactor;
  transport: HttpTransport;
  now?: () => number;
  endpoint?: (service: string, region: string) => string;
  /** Region whose IAM endpoint lists the account's projects. */
  bootstrapRegionId?: string;
  probeRegionId?: string;
  countryByRegion?: Record<string, string>;
  /** Project ids per region, if recorded by the owner (otherwise discovered through IAM). */
  projectIds?: Record<string, string>;
  /** VPC networking per region; absent ⇒ no provisioning there (creating VPC/subnet APIs were not read). */
  network?: (regionId: string) => HuaweiNetwork | undefined;
  rootVolume?: { volumetype: string; sizeGb: number };
  maxPlansPerRegion?: number;
  eipBandwidthMbit?: number;
  /** Capabilities the owner switches off for this adapter instance (reported `unsupported` whatever the probe finds). */
  disabledCapabilities?: CapabilityId[];
  /**
   * `read-only` (default; the only mode allowed against a live endpoint): see the class comment. `documented`: FIXTURE RUNS ONLY — the
   * mutating operations the docs describe are reported `supported` so the conformance kit can exercise them. Refused for live endpoints.
   */
  capabilityMode?: 'read-only' | 'documented';
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- vendor JSON is untyped until narrowed
interface Reply {
  status: number;
  json: Json | null;
  code: string | null;
  message: string | null;
  ambiguous: string | null;
  ev: RawEvidence;
}
const okStatus = (s: number) => s >= 200 && s < 300;
const TAG_TOKEN = 'nuzm-token';
const TAG_ORG = 'nuzm-org';
const TOKEN_TTL_MS = 23 * 3600_000; // tokens are valid 24 h (docs)

/** The documented idempotency identifier is a UUID (8-4-4-4-12): derive it deterministically from our 64-hex token. */
export const clientTokenUuid = (token: string): string => {
  const h = createHash('sha256').update(`huawei-client-token|${token}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export const serverName = (token: string, name: string): string =>
  `nz-${token}-${name.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 128);

export function categoryForCode(code: string | null, status: number): ErrorCategory {
  const c = code ?? '';
  if (/^(Common\.1503|Common\.0024|APIGW\.0308)/.test(c) || status === 429) return 'rate_limit';
  if (/^Ecs\.(0018|0319|0044)$/.test(c)) return 'capacity';
  if (/^Ecs\.(0001|0013|0021|0003|0066|0067|0069|0071)$/.test(c)) return 'quota';
  if (/^(Ecs\.0114|Ecs\.0614)$/.test(c)) return 'not_found';
  if (
    /^(Ecs\.0110|Pdp\.0001|Common\.0013|Common\.0018|APIGW\.0(301|302|305|306|307|310|801|802)|CBC\.0151)$/.test(
      c,
    )
  )
    return 'auth';
  if (/^Ecs\.0122$|^Ecs\.0124$/.test(c)) return 'conflict';
  if (/^(Common\.0001|Common\.0025)$/.test(c)) return 'provider_outage';
  if (c) return 'validation';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'provider_outage';
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 400) return 'validation';
  return 'unknown';
}

/** Decimal-safe conversion of a major-unit JSON number to integer minor units (2 digits assumed for USD, the documented currency). */
export function toMinorUnits(x: number, mode: 'ceil' | 'round'): string {
  if (!Number.isFinite(x) || x < 0)
    throw new RangeError('amount must be a non-negative finite number');
  const micro = BigInt(Math.round(x * 1e6));
  const q = micro / 10_000n;
  const r = micro % 10_000n;
  return (q + ((mode === 'ceil' ? r > 0n : r * 2n >= 10_000n) ? 1n : 0n)).toString();
}

export class HuaweiEcsAdapter implements ComputeAdapter {
  readonly id = 'huawei-ecs';
  readonly kind = 'compute' as const;
  readonly contractVersion = CONTRACT_VERSION;
  readonly probeCache = new ProbeCache();
  private readonly now: () => number;
  private readonly endpoint: (s: string, r: string) => string;
  private readonly bootstrap: string;
  private readonly probeRegion: string;
  private readonly countries: Record<string, string>;
  private readonly volume: { volumetype: string; sizeGb: number };
  private readonly mode: 'read-only' | 'documented';
  private readonly projects = new Map<string, string>();
  private readonly tokens = new Map<string, { token: string; projectId: string; at: number }>();
  private readonly tokenRegion = new Map<string, string>();

  constructor(private readonly o: HuaweiOptions) {
    this.now = o.now ?? Date.now;
    this.endpoint = o.endpoint ?? defaultEndpoint;
    this.bootstrap = o.bootstrapRegionId ?? 'ap-southeast-1';
    this.probeRegion = o.probeRegionId ?? this.bootstrap;
    this.countries = { ...DOCUMENTED_REGION_COUNTRY, ...(o.countryByRegion ?? {}) };
    this.volume = o.rootVolume ?? { volumetype: 'SSD', sizeGb: 40 };
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
  private evNow(op: string, summary: string): RawEvidence {
    return this.ev('fixture', op, summary);
  }
  private refOf(region: string, id: string): string {
    return `${region}/${id}`;
  }
  private parseRef(ref: string): { region: string; id: string } | null {
    const m =
      /^([a-z0-9-]{3,40})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
        ref,
      );
    return m ? { region: m[1]!, id: m[2]! } : null;
  }
  private arr(x: unknown): Json[] {
    return Array.isArray(x) ? (x as Json[]) : [];
  }

  /** Low-level send: AK/SK signing (documented as the recommended method) or a cached IAM token, chosen by the vault fields. */
  private async send(
    ctx: AccountContext,
    s: {
      service: 'ecs' | 'evs' | 'ces' | 'ims' | 'iam' | 'bss';
      region: string;
      method: 'GET' | 'POST';
      path: string; // may contain {project_id}
      query?: Record<string, string>;
      body?: unknown;
      headers?: Record<string, string>;
      op: string;
      tokenScope?: 'project' | 'domain';
      extraRedact?: string;
    },
  ): Promise<Reply> {
    const base = this.endpoint(s.service, s.region).replace(/\/$/, '');
    const kind = this.o.transport.evidenceKind(base);
    if (this.mode === 'documented' && kind === 'live')
      throw new Error(
        'capabilityMode "documented" is for fixture runs only and is refused for live endpoints',
      );
    const mk = (
      status: number,
      summary: string,
      json: Json | null,
      code: string | null,
      message: string | null,
      ambiguous: string | null,
    ): Reply => ({
      status,
      json,
      code,
      message,
      ambiguous,
      ev: this.ev(
        kind,
        s.op,
        summary,
        {
          method: s.method,
          service: s.service,
          region: s.region,
          path: s.path.replace(/[0-9a-f]{32}|[0-9a-f-]{36}/g, ':id'),
          query: s.query,
        },
        { status, code },
      ),
    });
    const material = await this.o.vault.resolve(ctx.credentialRef);
    this.o.redactor.register(material);
    const f = material.fields;
    let path = s.path;
    const headers: Record<string, string> = { ...(s.headers ?? {}) };
    if (path.includes('{project_id}')) {
      const pid = await this.projectId(ctx, s.region);
      if (typeof pid !== 'string') return pid;
      path = path.replace('{project_id}', pid);
    }
    const body = s.body === undefined ? '' : JSON.stringify(s.body);
    const query = s.query ?? {};
    const url = new URL(base);
    let signedHeaders: Record<string, string>;
    let qs: string;
    if (f.accessKey && f.secretKey) {
      const sig = signSdkHmacSha256({
        method: s.method,
        path,
        query,
        host: url.host,
        body,
        date: sdkDate(this.now()),
        accessKey: f.accessKey,
        secretKey: f.secretKey,
      });
      signedHeaders = sig.headers;
      qs = sig.queryString;
    } else if (f.iamUser && f.iamPassword && f.domainName) {
      const t = await this.token(
        ctx,
        f as Record<string, string>,
        s.region,
        s.tokenScope ?? 'project',
      );
      if (typeof t !== 'string') return t;
      signedHeaders = { 'content-type': 'application/json', 'x-auth-token': t };
      qs = Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
        .join('&');
    } else
      return mk(
        401,
        'credential material has neither accessKey+secretKey nor iamUser+iamPassword+domainName',
        null,
        'Common.0013',
        'no credentials',
        null,
      );
    try {
      const res = await this.o.transport.send({
        method: s.method,
        url: `${base}${path}${qs ? `?${qs}` : ''}`,
        headers: { ...signedHeaders, ...headers },
        ...(body ? { body } : {}),
        timeoutMs: ctx.deadlineMs,
      });
      let json: Json | null = null;
      try {
        json = res.body ? (JSON.parse(res.body) as Json) : null;
      } catch {
        /* non-JSON error body (CES uses plain strings) */
      }
      // error shapes: ECS {error:{code,message}}, gateway/BSS {error_code,error_msg|error_message}
      const e = (json?.error ?? json) as Json | null;
      const code =
        typeof e?.code === 'string'
          ? e.code
          : typeof json?.error_code === 'string'
            ? (json.error_code as string)
            : null;
      const message =
        typeof e?.message === 'string'
          ? e.message
          : typeof json?.error_msg === 'string'
            ? (json.error_msg as string)
            : typeof json?.error_message === 'string'
              ? (json.error_message as string)
              : null;
      return mk(
        res.status,
        `${s.op} (${s.region}) -> HTTP ${res.status}${code ? ` ${code}` : ''}`,
        json,
        code,
        message,
        null,
      );
    } catch (e) {
      if (e instanceof TransportAmbiguousError || (e as Error).name === 'AdapterTimeoutError')
        return mk(
          0,
          `${s.op} (${s.region}): ${(e as Error).message}`,
          null,
          null,
          null,
          (e as Error).message,
        );
      throw e;
    }
  }

  /** IAM token (`POST /v3/auth/tokens`), cached for 23 h (docs: valid 24 h; cache it). */
  private async token(
    ctx: AccountContext,
    f: Record<string, string>,
    region: string,
    scope: 'project' | 'domain',
  ): Promise<string | Reply> {
    const key = `${ctx.providerAccountId}|${scope === 'domain' ? 'domain' : region}`;
    const hit = this.tokens.get(key);
    if (hit && this.now() - hit.at < TOKEN_TTL_MS) return hit.token;
    const base = this.endpoint('iam', scope === 'domain' ? this.bootstrap : region).replace(
      /\/$/,
      '',
    );
    const kind = this.o.transport.evidenceKind(base);
    const body = {
      auth: {
        identity: {
          methods: ['password'],
          password: {
            user: { name: f.iamUser, password: f.iamPassword, domain: { name: f.domainName } },
          },
        },
        scope:
          scope === 'domain' ? { domain: { name: f.domainName } } : { project: { name: region } },
      },
    };
    try {
      const res = await this.o.transport.send({
        method: 'POST',
        url: `${base}/v3/auth/tokens`,
        headers: { 'content-type': 'application/json;charset=utf8' },
        body: JSON.stringify(body),
        timeoutMs: ctx.deadlineMs,
      });
      const token = res.headers['x-subject-token'];
      let json: Json | null = null;
      try {
        json = JSON.parse(res.body) as Json;
      } catch {
        /* ignore */
      }
      if (res.status === 201 && token) {
        this.o.redactor.register(token);
        const projectId = String(json?.token?.project?.id ?? '');
        this.tokens.set(key, { token, projectId, at: this.now() });
        if (scope === 'project' && projectId)
          this.projects.set(`${ctx.providerAccountId}|${region}`, projectId);
        return token;
      }
      return {
        status: res.status,
        json,
        code: String(json?.error?.code ?? ''),
        message: null,
        ambiguous: null,
        ev: this.ev(kind, 'iam.token', `token request -> HTTP ${res.status}`, undefined, {
          status: res.status,
        }),
      };
    } catch (e) {
      return {
        status: 0,
        json: null,
        code: null,
        message: null,
        ambiguous: (e as Error).message,
        ev: this.ev(kind, 'iam.token', `token request: ${(e as Error).message}`),
      };
    }
  }

  /** Project id of a region: owner-recorded, else IAM (`GET /v3/projects?name=<region>`), else the token's project. */
  private async projectId(ctx: AccountContext, region: string): Promise<string | Reply> {
    const known =
      this.o.projectIds?.[region] ?? this.projects.get(`${ctx.providerAccountId}|${region}`);
    if (known) return known;
    const material = await this.o.vault.resolve(ctx.credentialRef);
    if (material.fields.iamUser) {
      const t = await this.token(ctx, material.fields as Record<string, string>, region, 'project');
      if (typeof t !== 'string') return t;
      const id = this.tokens.get(`${ctx.providerAccountId}|${region}`)?.projectId;
      if (id) return id;
    }
    const r = await this.send(ctx, {
      service: 'iam',
      region: this.bootstrap,
      method: 'GET',
      path: '/v3/projects',
      query: { name: region },
      op: 'iam.listProjects',
    });
    const p = this.arr(r.json?.projects).find((x) => x.name === region && x.enabled !== false);
    if (okStatus(r.status) && typeof p?.id === 'string') {
      this.projects.set(`${ctx.providerAccountId}|${region}`, p.id as string);
      return p.id as string;
    }
    return okStatus(r.status)
      ? {
          ...r,
          status: 403,
          code: 'APIGW.0801',
          message: `the account has no project for region ${region}`,
        }
      : r;
  }

  private failFrom<T>(r: Reply): OperationResult<T> {
    return opFail(
      r.ev,
      normalizedError(
        categoryForCode(r.code, r.status),
        r.code ?? `http_${r.status}`,
        r.message ?? `HTTP ${r.status}`,
      ),
    );
  }
  private readFail<T>(r: Reply): OperationResult<T> {
    if (r.ambiguous)
      return opFail(r.ev, normalizedError('provider_outage', 'timeout', r.ambiguous, true));
    return this.failFrom<T>(r);
  }
  /** A failed MUTATION: no answer / 5xx / Common.0001 may have had an effect ⇒ `uncertain`. HTTP 202 with an error body (Common.0024) is a refusal. */
  private mutFail<T>(r: Reply): OperationResult<T> {
    if (r.ambiguous) return opUncertain(r.ev, r.ambiguous);
    if ((r.status >= 500 && r.status < 600) || r.code === 'Common.0001')
      return opUncertain(r.ev, `provider answered HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
    return this.failFrom<T>(r);
  }
  /** Success means 2xx WITHOUT an error body (the docs list Common.0024 "flow limit" with HTTP 202). */
  private good(r: Reply): boolean {
    return okStatus(r.status) && !r.ambiguous && !(r.json && (r.json.error || r.json.error_code));
  }

  // ---- AdapterBase --------------------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext): Promise<CapabilityReport> {
    const evidence: RawEvidence[] = [];
    const caps: Partial<Record<CapabilityId, CapabilityState>> = {};
    const region = this.probeRegion;
    const list = await this.send(ctx, {
      service: 'ecs',
      region,
      method: 'GET',
      path: '/v1/{project_id}/cloudservers/detail',
      query: { limit: '1' },
      op: 'probe.listServers',
    });
    evidence.push(list.ev);
    const readable = this.good(list);
    caps['compute.inspect'] = readable ? 'supported' : 'unknown';
    caps['compute.find-by-token'] = readable ? 'supported' : 'unknown'; // the documented `name` filter is part of the same list API
    const server = this.arr(list.json?.servers)[0];
    if (readable) {
      const flavors = await this.send(ctx, {
        service: 'ecs',
        region,
        method: 'GET',
        path: '/v1/{project_id}/cloudservers/flavors',
        op: 'probe.flavors',
      });
      evidence.push(flavors.ev);
      const flavor = this.arr(flavors.json?.flavors)[0];
      if (this.good(flavors) && flavor?.id) {
        const q = await this.priceOf(ctx, region, [String(flavor.id)]);
        evidence.push(q.ev);
        caps['compute.quote-api'] = q.prices.has(String(flavor.id)) ? 'supported' : 'unknown';
      } else caps['compute.quote-api'] = 'unknown';
      const cyc = this.iso().slice(0, 7);
      const bill = await this.send(ctx, {
        service: 'bss',
        region,
        method: 'POST',
        path: '/v2/bills/customer-bills/res-records/query',
        body: { cycle: cyc, cloud_service_type: 'hws.service.type.ec2', offset: 0, limit: 1 },
        op: 'probe.bill',
      });
      evidence.push(bill.ev);
      caps['compute.billing-export'] = this.good(bill) ? 'supported' : 'unknown';
      if (server?.id) {
        const to = this.now();
        const m = await this.send(ctx, {
          service: 'ces',
          region,
          method: 'POST',
          path: '/V1.0/{project_id}/batch-query-metric-data',
          body: {
            metrics: [
              {
                namespace: 'SYS.ECS',
                metric_name: 'cpu_util',
                dimensions: [{ name: 'instance_id', value: String(server.id) }],
              },
            ],
            period: '300',
            filter: 'average',
            from: to - 3_600_000,
            to,
          },
          op: 'probe.metrics',
        });
        evidence.push(m.ev);
        caps['compute.metrics'] = this.good(m) ? 'supported' : 'unknown';
      } else caps['compute.metrics'] = 'unknown';
    }
    // no read-only proof exists for these (the Create dry_run flag is deliberately NOT used by the probe): unknown until live verification
    const mut: CapabilityState = this.mode === 'documented' && readable ? 'supported' : 'unknown';
    for (const id of [
      'compute.provision',
      'compute.delete',
      'compute.action.start',
      'compute.action.stop',
      'compute.action.reboot',
      'compute.action.resize',
      'compute.action.snapshot',
    ] as const)
      caps[id] = mut;
    for (const id of this.o.disabledCapabilities ?? []) caps[id] = 'unsupported';
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
    const r = await this.send(ctx, {
      service: 'ecs',
      region: this.probeRegion,
      method: 'GET',
      path: '/v1/{project_id}/cloudservers/detail',
      query: { limit: '1' },
      op: 'health',
    });
    const cat = categoryForCode(r.code, r.status);
    const state = this.good(r)
      ? 'healthy'
      : cat === 'rate_limit'
        ? 'degraded'
        : r.ambiguous || r.status >= 500 || cat === 'auth'
          ? 'unhealthy'
          : 'unknown';
    return {
      state,
      checkedAt: this.iso(),
      latencyMs: this.now() - t0,
      detail: r.ambiguous ?? r.code ?? `HTTP ${r.status}`,
      evidence: [r.ev],
    };
  }

  async listRegions(ctx: AccountContext): Promise<ProviderRegion[]> {
    const material = await this.o.vault.resolve(ctx.credentialRef);
    const tokenMode = !!material.fields.iamUser && !material.fields.accessKey;
    // the account's own project list is the account-side proof of which regions it can use (IAM: project name = region id)
    const r = tokenMode
      ? await this.send(ctx, {
          service: 'iam',
          region: this.bootstrap,
          method: 'GET',
          path: '/v3/auth/projects',
          op: 'listRegions',
          tokenScope: 'domain',
        })
      : await this.send(ctx, {
          service: 'iam',
          region: this.bootstrap,
          method: 'GET',
          path: '/v3/projects',
          query: { per_page: '1000' },
          op: 'listRegions',
        });
    if (!this.good(r))
      throw new Error(`listing the account's projects failed: ${r.code ?? r.status}`);
    const out: ProviderRegion[] = [];
    for (const p of this.arr(r.json?.projects)) {
      const id = String(p.name ?? '');
      if (!id || p.enabled === false || !this.countries[id]) continue;
      if (typeof p.id === 'string') this.projects.set(`${ctx.providerAccountId}|${id}`, p.id);
      out.push({
        providerRegionId: id,
        countryCode: this.countries[id]!,
        displayName: id,
        // `verified` = the region's project is in THIS account's own project list AND the observation is live. Fixture runs never verify.
        verifiedAt: r.ev.kind === 'live' ? this.iso() : null,
        evidence: [
          this.ev(
            r.ev.kind,
            'listRegions',
            `project for region ${id} present in the account's IAM project list`,
            undefined,
            { regionId: id },
          ),
        ],
      });
    }
    return out;
  }

  private availabilityOf(extra: Json): PlanAvailability {
    const OK = new Set(['normal', 'obt', 'promotion']);
    const region = String(extra['cond:operation:status'] ?? 'normal');
    const az = String(extra['cond:operation:az'] ?? '');
    const states = az ? [...az.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]!) : [];
    const eff = states.length ? states : [region];
    if (eff.some((s) => OK.has(s))) return 'available';
    if (eff.some((s) => /sellout/.test(s))) return 'sold_out';
    return 'unavailable'; // abandon, or anything undocumented
  }

  private async priceOf(
    ctx: AccountContext,
    region: string,
    flavors: string[],
  ): Promise<{ ev: RawEvidence; prices: Map<string, { amount: number; currency: string }> }> {
    const pid = await this.projectId(ctx, region);
    const prices = new Map<string, { amount: number; currency: string }>();
    if (typeof pid !== 'string') return { ev: pid.ev, prices };
    const items = flavors.flatMap((fl, n) => [
      {
        id: `${n}a`,
        cloud_service_type: 'hws.service.type.ec2',
        resource_type: 'hws.resource.type.vm',
        resource_spec: `${fl}.linux`,
        region,
        usage_factor: 'Duration',
        usage_value: 1,
        usage_measure_id: 4,
        subscription_num: 1,
      },
      {
        id: `${n}b`,
        cloud_service_type: 'hws.service.type.ebs',
        resource_type: 'hws.resource.type.volume',
        resource_spec: this.volume.volumetype,
        region,
        usage_factor: 'Duration',
        usage_value: 1,
        usage_measure_id: 4,
        subscription_num: 1,
        resource_size: this.volume.sizeGb,
        size_measure_id: 17,
      },
    ]);
    const r = await this.send(ctx, {
      service: 'bss',
      region,
      method: 'POST',
      path: '/v2/bills/ratings/on-demand-resources',
      body: { project_id: pid, product_infos: items, inquiry_precision: 1 },
      op: 'price',
    });
    if (this.good(r)) {
      const cur =
        typeof r.json?.currency === 'string' && /^[A-Z]{3}$/.test(r.json.currency as string)
          ? (r.json.currency as string)
          : 'USD'; // docs: blank means USD
      const byId = new Map(this.arr(r.json?.product_rating_results).map((x) => [String(x.id), x]));
      flavors.forEach((fl, n) => {
        const a = byId.get(`${n}a`);
        const b = byId.get(`${n}b`);
        if (typeof a?.amount === 'number' && typeof b?.amount === 'number')
          prices.set(fl, { amount: (a.amount as number) + (b.amount as number), currency: cur });
      });
    }
    return { ev: r.ev, prices };
  }

  async listPlans(ctx: AccountContext, region: string): Promise<ProviderPlan[]> {
    if (!this.countries[region]) return [];
    const r = await this.send(ctx, {
      service: 'ecs',
      region,
      method: 'GET',
      path: '/v1/{project_id}/cloudservers/flavors',
      op: 'listPlans',
    });
    if (!this.good(r)) throw new Error(`flavor listing failed: ${r.code ?? r.status}`);
    const rank = { available: 0, sold_out: 1, unavailable: 2 } as const;
    const flavors = this.arr(r.json?.flavors)
      .filter((f) => Number(f.vcpus) >= 1 && Number(f.vcpus) <= 8 && Number(f.ram) <= 32 * 1024)
      .filter((f) => {
        const ch = String(f.os_extra_specs?.['cond:operation:charge'] ?? '');
        return !ch || ch.includes('demand');
      }) // pay-per-use only
      .map((f) => ({ f, a: this.availabilityOf((f.os_extra_specs ?? {}) as Json) }))
      .filter((x) => x.a !== 'unavailable')
      .sort(
        (x, y) =>
          rank[x.a] - rank[y.a] ||
          Number(x.f.vcpus) - Number(y.f.vcpus) ||
          Number(x.f.ram) - Number(y.f.ram) ||
          String(x.f.id).localeCompare(String(y.f.id)),
      )
      .slice(0, this.o.maxPlansPerRegion ?? 20);
    const priced = await this.priceOf(
      ctx,
      region,
      flavors.map((x) => String(x.f.id)),
    );
    return flavors.map(({ f, a }) => {
      const p = priced.prices.get(String(f.id));
      return {
        planRef: String(f.id),
        providerRegionId: region,
        vcpu: Number(f.vcpus),
        memoryMb: Number(f.ram),
        diskGb: this.volume.sizeGb,
        // pay-per-use hourly price of flavor + system volume, USD (documented BSS currency); minor units NOT DOCUMENTED: 2 digits, rounded UP
        ...(p
          ? {
              price: {
                amountMinor: toMinorUnits(p.amount, 'ceil'),
                currency: p.currency,
                period: 'hour' as const,
              },
            }
          : {}),
        availability: a,
      };
    });
  }

  async listImages(ctx: AccountContext, region: string): Promise<ProviderImage[]> {
    const out: ProviderImage[] = [];
    let marker = '';
    for (let page = 0; page < 3; page++) {
      const r = await this.send(ctx, {
        service: 'ims',
        region,
        method: 'GET',
        path: '/v2/cloudimages',
        query: {
          __imagetype: 'gold',
          __os_type: 'Linux',
          status: 'active',
          limit: '100',
          ...(marker ? { marker } : {}),
        },
        op: 'listImages',
      });
      if (!this.good(r)) throw new Error(`image listing failed: ${r.code ?? r.status}`);
      for (const i of this.arr(r.json?.images))
        out.push({
          imageRef: String(i.id),
          providerRegionId: region,
          name: String(i.name ?? i.id),
          osFamily: String(i.__os_type ?? 'Linux').toLowerCase(),
        });
      marker = String(r.json?.page_info?.next_marker ?? '');
      if (!marker) break;
    }
    return out;
  }

  async catalog(ctx: AccountContext): Promise<CatalogSnapshot> {
    const regions = await this.listRegions(ctx);
    const plans: ProviderPlan[] = [];
    const images: ProviderImage[] = [];
    for (const r of regions) {
      plans.push(...(await this.listPlans(ctx, r.providerRegionId)));
      images.push(...(await this.listImages(ctx, r.providerRegionId)));
    }
    return {
      takenAt: this.iso(),
      regions,
      plans,
      images,
      evidence: regions.flatMap((r) => r.evidence),
    };
  }

  async quote(ctx: AccountContext, req: ProvisionRequest): Promise<ProviderQuote> {
    const p = await this.priceOf(ctx, req.providerRegionId, [req.planRef]);
    const x = p.prices.get(req.planRef);
    return {
      planRef: req.planRef,
      providerRegionId: req.providerRegionId,
      price: x
        ? { amountMinor: toMinorUnits(x.amount, 'ceil'), currency: x.currency, period: 'hour' }
        : null,
      derivedFromCatalog: false,
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------------------------------------------
  private async caps(ctx: AccountContext): Promise<Record<CapabilityId, CapabilityState>> {
    return this.probeCache.get(ctx.providerAccountId) ?? (await this.probe(ctx)).capabilities;
  }
  private statusOf(s: unknown): InstanceStatus {
    switch (s) {
      case 'ACTIVE':
      case 'REBOOT':
      case 'HARD_REBOOT':
      case 'MIGRATING':
      case 'RESIZE':
      case 'VERIFY_RESIZE':
      case 'REVERT_RESIZE':
        return 'running';
      case 'SHUTOFF':
        return 'stopped';
      case 'BUILD':
      case 'REBUILD':
        return 'provisioning';
      case 'DELETED':
        return 'deleted';
      default:
        return 'error'; // ERROR, SHELVED*, UNKNOWN, anything undocumented
    }
  }

  private async listByName(
    ctx: AccountContext,
    region: string,
    token: string,
  ): Promise<Reply & { found: Json | null }> {
    const r = await this.send(ctx, {
      service: 'ecs',
      region,
      method: 'GET',
      path: '/v1/{project_id}/cloudservers/detail',
      query: { name: `nz-${token}`, limit: '100' },
      op: 'findByToken',
    });
    const found =
      this.arr(r.json?.servers).find(
        (s) => typeof s.name === 'string' && (s.name as string).startsWith(`nz-${token}-`),
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
    const region = req.providerRegionId;
    if (!this.countries[region])
      return opFailCat(
        this.evNow('provision', 'unknown region'),
        'validation',
        'invalid_region',
        `region ${region} is not one this adapter maps to a documented country`,
      );
    const net = this.o.network?.(region);
    if (!net)
      return opFailCat(
        this.evNow('provision', 'network not configured'),
        'validation',
        'network_not_configured',
        `no VPC/subnet/security group is configured for ${region}`,
      );
    if (!/^[0-9a-f]{64}$/.test(req.idempotencyToken))
      return opFailCat(
        this.evNow('provision', 'bad token'),
        'validation',
        'invalid_token',
        'idempotency token must be 64 hex characters',
      );
    // the 8-hour X-Client-Token window makes a late replay unsafe: look the token up first, never create when it is already there
    const pre = await this.listByName(ctx, region, req.idempotencyToken);
    if (pre.ambiguous) return opUncertain(pre.ev, 'pre-create lookup did not answer');
    if (!this.good(pre)) return this.readFail(pre);
    if (pre.found) {
      const ref = this.refOf(region, String(pre.found.id));
      return opOk(pre.ev, { providerRef: ref }, ref, 'accepted');
    }
    const tags: Record<string, string> = {
      ...req.tags,
      [TAG_TOKEN]: req.idempotencyToken,
      [TAG_ORG]: req.tags['nuzm-org'] ?? orgTag('unknown'),
    };
    const userData = req.sshPublicKeys.length
      ? `#cloud-config\nssh_authorized_keys:\n${req.sshPublicKeys.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\n`
      : undefined;
    const server: Json = {
      imageRef: req.imageRef,
      flavorRef: req.planRef,
      name: serverName(req.idempotencyToken, req.name),
      vpcid: net.vpcId,
      nics: [{ subnet_id: net.subnetId }],
      root_volume: { volumetype: this.volume.volumetype, size: req.diskGb ?? this.volume.sizeGb },
      security_groups: [{ id: net.securityGroupId }],
      ...(net.availabilityZone ? { availability_zone: net.availabilityZone } : {}),
      publicip: {
        eip: {
          iptype: '5_bgp',
          bandwidth: {
            size: this.o.eipBandwidthMbit ?? 5,
            sharetype: 'PER',
            chargemode: 'traffic',
          },
        },
      },
      count: 1,
      extendparam: { chargingMode: 'postPaid' }, // V1.1: a String (V1 uses the integer 0) — a documented difference
      server_tags: Object.entries(tags)
        .slice(0, 20)
        .map(([key, value]) => ({ key, value })),
      // SSH keys travel as cloud-init user_data (a documented field; key pairs would need the keypair API, not read) — NOT VERIFIED
      ...(userData ? { user_data: Buffer.from(userData).toString('base64') } : {}),
    };
    const r = await this.send(ctx, {
      service: 'ecs',
      region,
      method: 'POST',
      path: '/v1.1/{project_id}/cloudservers',
      body: { server },
      headers: { 'x-client-token': clientTokenUuid(req.idempotencyToken) },
      op: 'provision',
    });
    if (!this.good(r)) return this.mutFail(r);
    const id =
      this.arr(r.json?.serverIds as unknown)[0] ??
      (Array.isArray(r.json?.serverIds) ? r.json!.serverIds[0] : undefined);
    if (typeof id !== 'string') return opUncertain(r.ev, 'create answered 2xx without a server id');
    this.tokenRegion.set(req.idempotencyToken, region);
    const ref = this.refOf(region, id);
    return opOk(r.ev, { providerRef: ref }, ref, 'accepted');
  }

  async inspect(ctx: AccountContext, ref: string): Promise<OperationResult<InstanceState>> {
    const p = this.parseRef(ref);
    if (!p)
      return opFailCat(
        this.evNow('inspect', 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Huawei server reference',
      );
    const r = await this.send(ctx, {
      service: 'ecs',
      region: p.region,
      method: 'GET',
      path: `/v1/{project_id}/cloudservers/${p.id}`,
      op: 'inspect',
    });
    // docs: a 404 on a just-created id means "being created, or creation failed" — ambiguous until the job finishes
    if (r.status === 404)
      return opFailCat(
        r.ev,
        'not_found',
        r.code ?? 'Ecs.0114',
        'server not visible (not created yet, failed, or released)',
      );
    if (!this.good(r)) return this.readFail(r);
    const s = (r.json?.server ?? {}) as Json;
    const ips: string[] = [];
    for (const list of Object.values((s.addresses ?? {}) as Record<string, Json[]>))
      for (const a of Array.isArray(list) ? list : [])
        if (a['OS-EXT-IPS:type'] === 'floating' && typeof a.addr === 'string')
          ips.push(a.addr as string);
    const tags: Record<string, string> = {};
    for (const t of Array.isArray(s.tags) ? (s.tags as unknown[]) : []) {
      const m = /^(nuzm-[a-z-]+)[=.](.*)$/.exec(String(t)); // docs contradict themselves on `key=value` vs `key.value`
      if (m) tags[m[1]!] = m[2]!;
    }
    return opOk(
      r.ev,
      {
        providerRef: ref,
        status: this.statusOf(s.status),
        providerRegionId: p.region,
        planRef: String(s.flavor?.id ?? ''),
        publicIps: [...new Set(ips)],
        tags,
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
    const known = this.tokenRegion.get(token);
    let regions: string[];
    if (known) regions = [known];
    else {
      const all = await this.listRegions(ctx).catch(() => null);
      if (!all)
        return opFailCat(
          this.evNow('findByToken', 'region list failed'),
          'provider_outage',
          'regions_unavailable',
          'cannot enumerate regions to search',
        );
      regions = all.map((x) => x.providerRegionId);
    }
    let last: Reply | null = null;
    for (const region of regions) {
      const r = await this.listByName(ctx, region, token);
      last = r;
      if (!this.good(r)) return this.readFail(r); // an unsearchable region ⇒ absence is NOT proven
      if (r.found) {
        const ref = this.refOf(region, String(r.found.id));
        this.tokenRegion.set(token, region);
        return opOk(r.ev, { providerRef: ref }, ref);
      }
    }
    return opOk(last?.ev ?? this.evNow('findByToken', 'no region searched'), null);
  }

  async act(
    ctx: AccountContext,
    ref: string,
    action: ComputeAction,
    params: Record<string, unknown>,
  ): Promise<OperationResult<void>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, actionCapability(action)))
      return opUnsupported(
        this.evNow(`act.${action}`, `${action} not supported`),
        `compute.action.${action}`,
      );
    const p = this.parseRef(ref);
    if (!p)
      return opFailCat(
        this.evNow(`act.${action}`, 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Huawei server reference',
      );
    const accepted = (r: Reply): OperationResult<void> => {
      if (r.status === 404)
        return opFailCat(r.ev, 'not_found', r.code ?? 'Ecs.0114', 'server not found');
      return this.good(r) ? opOk<void>(r.ev, undefined, ref, 'accepted') : this.mutFail(r);
    };
    const batch = (op: 'os-start' | 'os-stop' | 'reboot', extra: Json) =>
      this.send(ctx, {
        service: 'ecs',
        region: p.region,
        method: 'POST',
        path: '/v1/{project_id}/cloudservers/action',
        body: { [op]: { ...extra, servers: [{ id: p.id }] } },
        op: `act.${action}`,
      });
    switch (action) {
      case 'start':
        return accepted(await batch('os-start', {}));
      case 'stop':
        return accepted(await batch('os-stop', { type: 'SOFT' }));
      case 'reboot':
        return accepted(await batch('reboot', { type: 'SOFT' }));
      case 'resize': {
        const target = typeof params.planRef === 'string' ? params.planRef : '';
        if (!/^[a-z0-9]+\.[a-z0-9.]+$/.test(target))
          return opFailCat(
            this.evNow('act.resize', 'bad target'),
            'validation',
            'invalid_plan',
            'params.planRef must be a flavor id',
          );
        const cur = await this.inspect(ctx, ref);
        if (cur.status !== 'succeeded') return cur as unknown as OperationResult<void>;
        if (cur.data!.status !== 'stopped')
          return opFailCat(
            cur.raw,
            'conflict',
            'invalid_state',
            'docs: the ECS must be stopped before its specifications can be modified',
          );
        return accepted(
          await this.send(ctx, {
            service: 'ecs',
            region: p.region,
            method: 'POST',
            path: `/v1.1/{project_id}/cloudservers/${p.id}/resize`,
            body: { resize: { flavorRef: target } },
            op: 'act.resize',
          }),
        );
      }
      case 'snapshot': {
        // ECS has no snapshot API: snapshot the boot volume through EVS
        const s = await this.send(ctx, {
          service: 'ecs',
          region: p.region,
          method: 'GET',
          path: `/v1/{project_id}/cloudservers/${p.id}`,
          op: 'act.snapshot.volume',
        });
        if (!this.good(s)) return this.readFail(s);
        const vol = this.arr(s.json?.server?.['os-extended-volumes:volumes_attached']).find(
          (v) => String(v.bootIndex) === '0',
        );
        if (!vol?.id)
          return opFailCat(
            s.ev,
            'not_found',
            'boot_volume_not_found',
            'no boot volume found on the server',
          );
        return accepted(
          await this.send(ctx, {
            service: 'evs',
            region: p.region,
            method: 'POST',
            path: '/v2/{project_id}/cloudsnapshots',
            body: {
              snapshot: {
                volume_id: String(vol.id),
                name: `nuzm-snap-${Math.floor(this.now() / 1000)}`,
                force: false,
              },
            },
            op: 'act.snapshot',
          }),
        );
      }
    }
  }

  async delete(ctx: AccountContext, ref: string): Promise<OperationResult<void>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.delete'))
      return opUnsupported(this.evNow('delete', 'delete not supported'), 'compute.delete');
    const p = this.parseRef(ref);
    if (!p)
      return opFailCat(
        this.evNow('delete', 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Huawei server reference',
      );
    // what a delete of a non-existent server answers is NOT DOCUMENTED: look first, so a second delete is a clean no-op
    const cur = await this.send(ctx, {
      service: 'ecs',
      region: p.region,
      method: 'GET',
      path: `/v1/{project_id}/cloudservers/${p.id}`,
      op: 'delete.inspect',
    });
    if (cur.status === 404) return opOk<void>(cur.ev, undefined, ref);
    if (!this.good(cur))
      return cur.ambiguous ? opUncertain(cur.ev, cur.ambiguous) : this.mutFail(cur);
    // EIP and volumes are released with the server: leftovers would stay billable
    const r = await this.send(ctx, {
      service: 'ecs',
      region: p.region,
      method: 'POST',
      path: '/v1/{project_id}/cloudservers/delete',
      body: { servers: [{ id: p.id }], delete_publicip: true, delete_volume: true },
      op: 'delete',
    });
    if (r.status === 404) return opOk<void>(r.ev, undefined, ref);
    if (!this.good(r)) return this.mutFail(r);
    // delete is an asynchronous job: `succeeded` only when ONE check of the job already says SUCCESS, otherwise `accepted`
    const jobId = typeof r.json?.job_id === 'string' ? (r.json.job_id as string) : null;
    if (jobId) {
      const j = await this.send(ctx, {
        service: 'ecs',
        region: p.region,
        method: 'GET',
        path: `/v1/{project_id}/jobs/${jobId}`,
        op: 'delete.job',
      });
      if (this.good(j) && j.json?.status === 'SUCCESS') return opOk<void>(j.ev, undefined, ref);
    }
    return opOk<void>(r.ev, undefined, ref, 'accepted');
  }

  async metrics(
    ctx: AccountContext,
    ref: string,
    window: { from: string; to: string },
  ): Promise<OperationResult<Metrics>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.metrics'))
      return opUnsupported(this.evNow('metrics', 'metrics not supported'), 'compute.metrics');
    const p = this.parseRef(ref);
    if (!p)
      return opFailCat(
        this.evNow('metrics', 'invalid reference'),
        'not_found',
        'invalid_ref',
        'not a Huawei server reference',
      );
    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    // docs: metrics × (to − from) / period ≤ 3000, period in {1,60,300,1200,3600,14400,86400} (seconds)
    const period = [60, 300, 1200, 3600, 14400, 86400].find(
      (x) => (to - from) / (x * 1000) <= 3000,
    );
    if (!period || !(to > from))
      return opFailCat(
        this.evNow('metrics', 'window'),
        'validation',
        'window_too_large',
        'window exceeds the documented 3000-point limit',
      );
    const r = await this.send(ctx, {
      service: 'ces',
      region: p.region,
      method: 'POST',
      path: '/V1.0/{project_id}/batch-query-metric-data',
      body: {
        metrics: [
          {
            namespace: 'SYS.ECS',
            metric_name: 'cpu_util',
            dimensions: [{ name: 'instance_id', value: p.id }],
          },
        ],
        period: String(period),
        filter: 'average',
        from,
        to,
      },
      op: 'metrics',
    });
    if (!this.good(r)) return this.readFail(r);
    const series = this.arr(r.json?.metrics).map((m) => ({
      name: String(m.metric_name),
      unit: String(m.unit ?? ''),
      points: this.arr(m.datapoints)
        .filter((d) => typeof d.average === 'number')
        .map((d) => ({ t: new Date(Number(d.timestamp)).toISOString(), v: d.average as number })),
    }));
    return opOk(r.ev, { window, series }, ref);
  }

  /** Cost capture: BSS resource usage details (POST …/res-records/query), USD. `offset` semantics are only exemplified in the docs (NOT VERIFIED). */
  async fetchBilling(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]> {
    const out: ProviderCostRecord[] = [];
    const cycles: string[] = [];
    for (
      let y = Number(period.from.slice(0, 4)), m = Number(period.from.slice(5, 7));
      cycles.length < 24;
    ) {
      const c = `${y}-${String(m).padStart(2, '0')}`;
      cycles.push(c);
      if (c >= period.to.slice(0, 7)) break;
      if (++m > 12) {
        m = 1;
        y += 1;
      }
    }
    for (const cycle of cycles) {
      for (let offset = 0, n = 0; n < 50; n++) {
        const r = await this.send(ctx, {
          service: 'bss',
          region: this.probeRegion,
          method: 'POST',
          path: '/v2/bills/customer-bills/res-records/query',
          body: {
            cycle,
            cloud_service_type: 'hws.service.type.ec2',
            include_zero_record: false,
            offset,
            limit: 100,
          },
          op: 'fetchBilling',
        });
        if (!this.good(r)) throw new Error(`usage details failed: ${r.code ?? r.status}`);
        const recs = this.arr(r.json?.monthly_records);
        const cur = typeof r.json?.currency === 'string' ? (r.json.currency as string) : 'USD';
        const [y, m] = cycle.split('-').map(Number) as [number, number];
        for (const x of recs) {
          const amt = typeof x.consume_amount === 'number' ? (x.consume_amount as number) : null;
          if (amt === null || amt < 0) continue;
          out.push({
            providerRef:
              typeof x.res_instance_id === 'string' && x.res_instance_id
                ? (x.res_instance_id as string)
                : null,
            periodStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
            periodEnd: new Date(Date.UTC(y, m, 1)).toISOString(),
            amountMinor: toMinorUnits(amt, 'round'),
            currency: cur,
            description:
              `${String(x.cloud_service_type ?? 'ecs')} ${String(x.product_spec_desc ?? '')}`.trim(),
          });
        }
        if (recs.length < 100) break;
        offset += recs.length;
      }
    }
    return out;
  }
}
