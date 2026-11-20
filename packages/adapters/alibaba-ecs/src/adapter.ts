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
import { acsDate, newNonce, signV3 } from './signer';

/**
 * `alibaba-ecs` — Alibaba Cloud ECS adapter (RPC API 2014-05-26) built ONLY from the official documentation (see README for every page
 * and the date read). NOT VERIFIED against any account: HG-05-01 is PENDING and no call to the vendor was ever made.
 *
 * Design points that come from the documentation:
 *  - RunInstances takes `ClientToken` (ASCII, ≤ 64) → our idempotency token (a 64-hex sha256) is passed as-is; replaying it returns the
 *    first response. ClientToken is NOT queryable, so `findByToken` uses a `nuzm-token` TAG (DescribeInstances `Tag.N.Key/Value`).
 *  - `DryRun` exists on RunInstances/Start/Stop/Reboot/ModifyInstanceSpec/DeleteInstance and "creates nothing; success returns the error
 *    DryRunOperation" → the probe proves permission with DryRun and nothing else.
 *  - Regions come from DescribeRegions of the account; a region is only `verified` from LIVE evidence. Saudi Arabia (`me-central-1`) is
 *    in the docs' region list but nothing here assumes the account can use it.
 */
export const ALIBABA_ECS_VERSION = '2014-05-26';
export const ALIBABA_BSS_VERSION = '2017-12-14';
export const DEFAULT_BSS_ENDPOINT = 'https://business.ap-southeast-1.aliyuncs.com';
export const defaultEndpoint = (regionId: string): string => `https://ecs.${regionId}.aliyuncs.com`;

/**
 * Region → country, ONLY for regions whose country the documentation states
 * (https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-endpoint: "Saudi Arabia (Riyadh)", "UAE (Dubai)",
 * "Singapore", read 2026-11-18). A region that is not in this table (or in `countryByRegion`) is skipped: unknown = unsupported.
 */
export const DOCUMENTED_REGION_COUNTRY: Record<string, string> = {
  'me-central-1': 'SA',
  'me-east-1': 'AE',
  'ap-southeast-1': 'SG',
};

export interface AlibabaNetwork {
  vSwitchId: string;
  securityGroupId: string;
  zoneId?: string;
}
export interface AlibabaOptions {
  vault: VaultClient;
  redactor: Redactor;
  transport: HttpTransport;
  now?: () => number;
  /** Endpoint per region; default is the documented pattern `https://ecs.<region>.aliyuncs.com`. */
  endpoint?: (regionId: string) => string;
  bssEndpoint?: string;
  /** Region whose endpoint answers DescribeRegions (the doc lists no global endpoint for commercial regions). */
  bootstrapRegionId?: string;
  /** Region in which `probe()` looks for an existing instance to DryRun against. */
  probeRegionId?: string;
  countryByRegion?: Record<string, string>;
  /** VPC networking per region (RunInstances needs VSwitchId + SecurityGroupId; creating them needs APIs not read) — absent ⇒ no provisioning there. */
  network?: (regionId: string) => AlibabaNetwork | undefined;
  systemDisk?: { category: string; sizeGb: number };
  maxPlansPerRegion?: number;
  instanceTypeFamilies?: string[];
  internetMaxBandwidthOut?: number;
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
const ok = (r: Reply) => r.status >= 200 && r.status < 300 && !r.ambiguous;

const MAX_PAGES = 5;
const TAG_TOKEN = 'nuzm-token';
const TAG_ORG = 'nuzm-org';

export function categoryForCode(code: string | null, status: number): ErrorCategory {
  const c = code ?? '';
  if (/^Throttling/.test(c)) return 'rate_limit';
  if (
    /^(OperationDenied\.NoStock|Zone\.Not|InvalidOperation\.PublicIpAddressNoStock|LackResource|InvalidDedicatedHost\.NotEnoughResource)/.test(
      c,
    )
  )
    return 'capacity';
  if (
    /^QuotaExceed/.test(c) ||
    /^(Account\.Arrearage|InsufficientBalance|InvalidAccountStatus|Forbidden\.InDebt|DiskInArrears|InstanceExpiredOrInArrears)/.test(
      c,
    )
  )
    return 'quota';
  if (/^(InvalidInstanceId\.NotFound|InvalidDiskId\.NotFound|InvalidSnapshotId\.NotFound)$/.test(c))
    return 'not_found';
  if (
    /^(Forbidden|Forbbiden|Unauthorized|InvalidAccessKeyId|SignatureDoesNotMatch|InvalidTimeStamp|SignatureNonceUsed|RegionUnauthorized|RealNameAuthentication)/.test(
      c,
    )
  )
    return 'auth';
  if (
    /^(IncorrectInstanceStatus|IncorrectDiskStatus|Idempotent|InvalidOperation\.DeletionProtection|InvalidInstanceStatus|KeyPair\.AlreadyExist)/.test(
      c,
    )
  )
    return 'conflict';
  if (/^(InternalError|ServiceUnavailable|LimitedOperation\.ServiceUnavailable)/.test(c))
    return 'provider_outage';
  if (c) return 'validation';
  if (status === 429) return 'rate_limit';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'provider_outage';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400) return 'validation';
  return 'unknown';
}

/** Decimal-safe conversion of a JSON major-unit number to integer minor units (2 decimals: CNY, USD, JPY handled by the caller's table). */
export function toMinorUnits(x: number, mode: 'ceil' | 'round'): string {
  if (!Number.isFinite(x) || x < 0)
    throw new RangeError('amount must be a non-negative finite number');
  const micro = BigInt(Math.round(x * 1e6)); // ≤ 6 decimals; avoids binary-float artefacts such as 0.17*100 = 17.000000000000004
  const per = 10_000n; // 1e6 micro-units per major unit / 100 minor units
  const q = micro / per;
  const r = micro % per;
  const up = mode === 'ceil' ? r > 0n : r * 2n >= per;
  return (q + (up ? 1n : 0n)).toString();
}

const cycleOf = (iso: string): string => iso.slice(0, 7);
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (let i = 0; i < 24; i++) {
    const c = `${y}-${String(m).padStart(2, '0')}`;
    out.push(c);
    if (c >= end) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

export class AlibabaEcsAdapter implements ComputeAdapter {
  readonly id = 'alibaba-ecs';
  readonly kind = 'compute' as const;
  readonly contractVersion = CONTRACT_VERSION;
  readonly probeCache = new ProbeCache();
  private readonly now: () => number;
  private readonly endpoint: (r: string) => string;
  private readonly bss: string;
  private readonly bootstrap: string;
  private readonly probeRegion: string;
  private readonly countries: Record<string, string>;
  private readonly disk: { category: string; sizeGb: number };
  private readonly tokenRegion = new Map<string, string>();

  constructor(private readonly o: AlibabaOptions) {
    this.now = o.now ?? Date.now;
    this.endpoint = o.endpoint ?? defaultEndpoint;
    this.bss = o.bssEndpoint ?? DEFAULT_BSS_ENDPOINT;
    this.bootstrap = o.bootstrapRegionId ?? 'ap-southeast-1';
    this.probeRegion = o.probeRegionId ?? this.bootstrap;
    this.countries = { ...DOCUMENTED_REGION_COUNTRY, ...(o.countryByRegion ?? {}) };
    this.disk = o.systemDisk ?? { category: 'cloud_essd', sizeGb: 40 };
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
  private refOf(region: string, instanceId: string): string {
    return `${region}/${instanceId}`;
  }
  private parseRef(ref: string): { region: string; instanceId: string } | null {
    const m = /^([a-z0-9-]{3,40})\/(i-[A-Za-z0-9]{3,60})$/.exec(ref);
    return m ? { region: m[1]!, instanceId: m[2]! } : null;
  }

  /** One signed RPC call. Provider and transport problems are returned in the Reply, never thrown. */
  private async rpc(
    ctx: AccountContext,
    s: {
      service: 'ecs' | 'bss';
      region: string;
      action: string;
      params: Record<string, string>;
      mutating?: boolean;
    },
  ): Promise<Reply> {
    const base = s.service === 'ecs' ? this.endpoint(s.region) : this.bss;
    const version = s.service === 'ecs' ? ALIBABA_ECS_VERSION : ALIBABA_BSS_VERSION;
    const kind = this.o.transport.evidenceKind(base);
    const material = await this.o.vault.resolve(ctx.credentialRef);
    this.o.redactor.register(material);
    const id = material.fields.accessKeyId;
    const secret = material.fields.accessKeySecret;
    const opName = `${s.service}.${s.action}`;
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
        opName,
        summary,
        { action: s.action, region: s.region, params: Object.keys(s.params).sort() },
        { status, code },
      ),
    });
    if (!id || !secret)
      return mk(
        401,
        'credential material lacks accessKeyId/accessKeySecret',
        null,
        'InvalidAccessKeyId.NotFound',
        'no credentials',
        null,
      );
    const url = new URL(base);
    const signed = signV3({
      method: s.mutating ? 'POST' : 'GET',
      host: url.host,
      action: s.action,
      version,
      query: s.params,
      date: acsDate(this.now()),
      nonce: newNonce(),
      accessKeyId: id,
      accessKeySecret: secret,
    });
    try {
      const res = await this.o.transport.send({
        method: s.mutating ? 'POST' : 'GET',
        url: `${base.replace(/\/$/, '')}/?${signed.queryString}`,
        headers: signed.headers,
        timeoutMs: ctx.deadlineMs,
      });
      let json: Json | null = null;
      try {
        json = res.body ? (JSON.parse(res.body) as Json) : null;
      } catch {
        /* HTML/text error page */
      }
      const code = typeof json?.Code === 'string' ? (json.Code as string) : null;
      const message = typeof json?.Message === 'string' ? (json.Message as string) : null;
      return mk(
        res.status,
        `${opName} (${s.region}) -> HTTP ${res.status}${code ? ` ${code}` : ''}`,
        json,
        code,
        message,
        null,
      );
    } catch (e) {
      if (e instanceof TransportAmbiguousError || (e as Error).name === 'AdapterTimeoutError')
        return mk(
          0,
          `${opName} (${s.region}): ${(e as Error).message}`,
          null,
          null,
          null,
          (e as Error).message,
        );
      throw e;
    }
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
  /** A failed MUTATION: no answer, 500 and 503 may have had an effect (docs: retries are for 500/503/no response) ⇒ `uncertain`. */
  private mutFail<T>(r: Reply): OperationResult<T> {
    if (r.ambiguous) return opUncertain(r.ev, r.ambiguous);
    if (
      r.status === 500 ||
      r.status === 503 ||
      r.code === 'InternalError' ||
      r.code === 'ServiceUnavailable'
    )
      return opUncertain(r.ev, `provider answered HTTP ${r.status}${r.code ? ` ${r.code}` : ''}`);
    return this.failFrom<T>(r);
  }
  private arr(x: unknown): Json[] {
    return Array.isArray(x) ? (x as Json[]) : [];
  }

  // ---- AdapterBase --------------------------------------------------------------------------------------------------------
  private async dryRun(
    ctx: AccountContext,
    region: string,
    action: string,
    params: Record<string, string>,
  ): Promise<{ state: CapabilityState; ev: RawEvidence }> {
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action,
      params: { ...params, DryRun: 'true' },
      mutating: true,
    });
    // Only the documented success signal counts. A permission refusal is `unsupported`; anything else proves nothing.
    const state: CapabilityState =
      r.code === 'DryRunOperation'
        ? 'supported'
        : /^(Forbidden|Forbbiden|Unauthorized)/.test(r.code ?? '')
          ? 'unsupported'
          : 'unknown';
    return { state, ev: r.ev };
  }

  async probe(ctx: AccountContext): Promise<CapabilityReport> {
    const evidence: RawEvidence[] = [];
    const caps: Partial<Record<CapabilityId, CapabilityState>> = {};
    const region = this.probeRegion;
    const regions = await this.rpc(ctx, {
      service: 'ecs',
      region: this.bootstrap,
      action: 'DescribeRegions',
      params: { AcceptLanguage: 'en-US' },
    });
    evidence.push(regions.ev);
    if (!ok(regions)) {
      const report = { capabilities: completeCapabilities({}), evidence, probedAt: this.iso() };
      this.probeCache.set(ctx.providerAccountId, report);
      return report;
    }
    const list = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action: 'DescribeInstances',
      params: { RegionId: region, MaxResults: '10' },
    });
    evidence.push(list.ev);
    caps['compute.inspect'] = ok(list) ? 'supported' : 'unknown';
    const tagq = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action: 'DescribeInstances',
      params: {
        RegionId: region,
        MaxResults: '10',
        'Tag.1.Key': TAG_TOKEN,
        'Tag.1.Value': 'probe',
      },
    });
    evidence.push(tagq.ev);
    caps['compute.find-by-token'] = ok(tagq) ? 'supported' : 'unknown';
    const price = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action: 'DescribePrice',
      params: {
        RegionId: region,
        ResourceType: 'instance',
        InstanceType: 'ecs.g6.large',
        PriceUnit: 'Hour',
        Period: '1',
        Amount: '1',
      },
    });
    evidence.push(price.ev);
    caps['compute.quote-api'] = ok(price) ? 'supported' : 'unknown';

    // mutating capabilities: DryRun against an EXISTING instance of the account (none ⇒ unknown, never assumed)
    const existing = this.arr(list.json?.Instances?.Instance)[0];
    const iid = typeof existing?.InstanceId === 'string' ? (existing.InstanceId as string) : null;
    if (iid) {
      for (const [id, action, extra] of [
        ['compute.action.start', 'StartInstance', {}],
        ['compute.action.stop', 'StopInstance', {}],
        ['compute.action.reboot', 'RebootInstance', {}],
        [
          'compute.action.resize',
          'ModifyInstanceSpec',
          { InstanceType: String(existing!.InstanceType ?? '') },
        ],
        ['compute.delete', 'DeleteInstance', {}],
      ] as const) {
        const d = await this.dryRun(ctx, region, action, { InstanceId: iid, ...extra });
        caps[id] = d.state;
        evidence.push(d.ev);
      }
      const now = this.now();
      const mon = await this.rpc(ctx, {
        service: 'ecs',
        region,
        action: 'DescribeInstanceMonitorData',
        params: {
          InstanceId: iid,
          StartTime: acsDate(now - 600_000),
          EndTime: acsDate(now),
          Period: '60',
        },
      });
      evidence.push(mon.ev);
      caps['compute.metrics'] = ok(mon) ? 'supported' : 'unknown';
    }
    // provision: DryRun needs an image, an in-stock type and configured networking in the probe region
    const net = this.o.network?.(region);
    const img = (await this.listImages(ctx, region).catch(() => []))[0];
    const type = (await this.listPlans(ctx, region).catch(() => [])).find(
      (p) => p.availability === 'available',
    );
    if (net && img && type) {
      const d = await this.dryRun(ctx, region, 'RunInstances', {
        RegionId: region,
        ImageId: img.imageRef,
        InstanceType: type.planRef,
        SecurityGroupId: net.securityGroupId,
        VSwitchId: net.vSwitchId,
        Amount: '1',
        MinAmount: '1',
        'SystemDisk.Category': this.disk.category,
        'SystemDisk.Size': String(this.disk.sizeGb),
      });
      caps['compute.provision'] = d.state;
      evidence.push(d.ev);
    } else caps['compute.provision'] = 'unknown';
    caps['compute.action.snapshot'] = 'unknown'; // CreateSnapshot has no documented DryRun: only a live run can prove it
    // billing: a read-only DescribeInstanceBill proves the permission and the endpoint
    const cyc = cycleOf(this.iso());
    const bill = await this.rpc(ctx, {
      service: 'bss',
      region: 'bss',
      action: 'DescribeInstanceBill',
      params: { BillingCycle: cyc, ProductCode: 'ecs', MaxResults: '1' },
    });
    evidence.push(bill.ev);
    caps['compute.billing-export'] =
      ok(bill) && bill.json?.Success !== false ? 'supported' : 'unknown';

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
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: this.bootstrap,
      action: 'DescribeRegions',
      params: {},
    });
    const state = ok(r)
      ? 'healthy'
      : categoryForCode(r.code, r.status) === 'rate_limit'
        ? 'degraded'
        : r.ambiguous || r.status >= 500 || categoryForCode(r.code, r.status) === 'auth'
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
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: this.bootstrap,
      action: 'DescribeRegions',
      params: { AcceptLanguage: 'en-US' },
    });
    if (!ok(r)) throw new Error(`DescribeRegions failed: ${r.code ?? r.status}`);
    const rows = this.arr(r.json?.Regions?.Region);
    const kind = r.ev.kind;
    const out: ProviderRegion[] = [];
    const unmapped: string[] = [];
    for (const row of rows) {
      const id = String(row.RegionId ?? '');
      if (!id || row.Status === 'soldOut') continue;
      const country = this.countries[id];
      if (!country) {
        unmapped.push(id);
        continue;
      }
      out.push({
        providerRegionId: id,
        countryCode: country,
        displayName: String(row.LocalName ?? id),
        // `verified` = present in THIS account's own DescribeRegions listing AND observed live. Fixture runs never verify.
        verifiedAt: kind === 'live' ? this.iso() : null,
        evidence: [
          this.ev(
            kind,
            'listRegions',
            `region ${id} present in the account's DescribeRegions listing (status ${String(row.Status)})`,
            undefined,
            { regionId: id, unmappedCount: unmapped.length },
          ),
        ],
      });
    }
    return out;
  }

  private async stockByType(
    ctx: AccountContext,
    region: string,
  ): Promise<Map<string, PlanAvailability>> {
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action: 'DescribeAvailableResource',
      params: {
        RegionId: region,
        DestinationResource: 'InstanceType',
        InstanceChargeType: 'PostPaid',
        IoOptimized: 'optimized',
      },
    });
    if (!ok(r)) throw new Error(`DescribeAvailableResource failed: ${r.code ?? r.status}`);
    const best = new Map<string, PlanAvailability>();
    const rank: Record<PlanAvailability, number> = { available: 2, sold_out: 1, unavailable: 0 };
    for (const z of this.arr(r.json?.AvailableZones?.AvailableZone))
      for (const res of this.arr(z.AvailableResources?.AvailableResource))
        for (const sr of this.arr(res.SupportedResources?.SupportedResource)) {
          const v = String(sr.Value ?? '');
          if (!v) continue;
          const cat = String(sr.StatusCategory ?? '');
          const a: PlanAvailability =
            cat === 'WithStock'
              ? 'available'
              : /Without/.test(cat) || sr.Status === 'SoldOut'
                ? 'sold_out'
                : 'unavailable';
          if (rank[a] > rank[best.get(v) ?? 'unavailable'] || !best.has(v)) best.set(v, a);
        }
    return best;
  }

  async listPlans(ctx: AccountContext, region: string): Promise<ProviderPlan[]> {
    const regions = await this.listRegions(ctx);
    if (!regions.some((x) => x.providerRegionId === region)) return [];
    const stock = await this.stockByType(ctx, region);
    const fams = this.o.instanceTypeFamilies?.length ? this.o.instanceTypeFamilies : [undefined];
    const types: Json[] = [];
    for (const fam of fams) {
      let next = '';
      for (let page = 0; page < 3; page++) {
        const r = await this.rpc(ctx, {
          service: 'ecs',
          region,
          action: 'DescribeInstanceTypes',
          params: {
            MinimumCpuCoreCount: '1',
            MaximumCpuCoreCount: '8',
            MaximumMemorySize: '32',
            MaxResults: '100',
            ...(fam ? { InstanceTypeFamily: fam } : {}),
            ...(next ? { NextToken: next } : {}),
          },
        });
        if (!ok(r)) throw new Error(`DescribeInstanceTypes failed: ${r.code ?? r.status}`);
        types.push(...this.arr(r.json?.InstanceTypes?.InstanceType));
        next = String(r.json?.NextToken ?? '');
        if (!next) break;
      }
    }
    const rank = { available: 0, sold_out: 1, unavailable: 2 } as const;
    const chosen = types
      .filter((t) => stock.has(String(t.InstanceTypeId)))
      .sort(
        (a, b) =>
          rank[stock.get(String(a.InstanceTypeId))!] - rank[stock.get(String(b.InstanceTypeId))!] ||
          Number(a.CpuCoreCount) - Number(b.CpuCoreCount) ||
          Number(a.MemorySize) - Number(b.MemorySize) ||
          String(a.InstanceTypeId).localeCompare(String(b.InstanceTypeId)),
      )
      .slice(0, this.o.maxPlansPerRegion ?? 20);
    const plans: ProviderPlan[] = [];
    for (const t of chosen) {
      const planRef = String(t.InstanceTypeId);
      const p = await this.rpc(ctx, {
        service: 'ecs',
        region,
        action: 'DescribePrice',
        params: {
          RegionId: region,
          ResourceType: 'instance',
          InstanceType: planRef,
          'SystemDisk.Category': this.disk.category,
          'SystemDisk.Size': String(this.disk.sizeGb),
          PriceUnit: 'Hour',
          Period: '1',
          Amount: '1',
        },
      });
      const info = p.json?.PriceInfo?.Price as Json | undefined;
      // Price: DescribePrice returns major-unit JSON numbers; minor units are NOT DOCUMENTED. ISO 4217 minor units of 2 are assumed
      // for CNY/USD (the documented currencies); the hourly price is rounded UP to the next minor unit (never under-states cost).
      const trade = typeof info?.TradePrice === 'number' ? (info.TradePrice as number) : null;
      const cur =
        typeof info?.Currency === 'string' && /^[A-Z]{3}$/.test(info.Currency as string)
          ? (info.Currency as string)
          : null;
      const kbit = Number(t.InstanceBandwidthRx);
      plans.push({
        planRef,
        providerRegionId: region,
        vcpu: Number(t.CpuCoreCount),
        memoryMb: Math.round(Number(t.MemorySize) * 1024),
        diskGb: this.disk.sizeGb,
        ...(Number.isFinite(kbit) && kbit > 0
          ? { bandwidth: `${Math.round(kbit / 1000)} Mbit/s` }
          : {}),
        ...(ok(p) && trade !== null && cur
          ? {
              price: {
                amountMinor: toMinorUnits(trade, 'ceil'),
                currency: cur,
                period: 'hour' as const,
              },
            }
          : {}),
        availability: stock.get(planRef) ?? 'unavailable',
      });
    }
    return plans;
  }

  async listImages(ctx: AccountContext, region: string): Promise<ProviderImage[]> {
    const out: ProviderImage[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await this.rpc(ctx, {
        service: 'ecs',
        region,
        action: 'DescribeImages',
        params: {
          RegionId: region,
          ImageOwnerAlias: 'system',
          Status: 'Available',
          OSType: 'linux',
          PageSize: '100',
          PageNumber: String(page),
        },
      });
      if (!ok(r)) throw new Error(`DescribeImages failed: ${r.code ?? r.status}`);
      const rows = this.arr(r.json?.Images?.Image);
      for (const i of rows)
        out.push({
          imageRef: String(i.ImageId),
          providerRegionId: region,
          name: String(i.OSNameEn ?? i.ImageName ?? i.ImageId),
          osFamily: String(i.OSType ?? 'linux'),
        });
      if (out.length >= Number(r.json?.TotalCount ?? 0) || rows.length === 0) break;
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
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: req.providerRegionId,
      action: 'DescribePrice',
      params: {
        RegionId: req.providerRegionId,
        ResourceType: 'instance',
        InstanceType: req.planRef,
        'SystemDisk.Category': this.disk.category,
        'SystemDisk.Size': String(req.diskGb ?? this.disk.sizeGb),
        PriceUnit: 'Hour',
        Period: '1',
        Amount: '1',
      },
    });
    const info = r.json?.PriceInfo?.Price as Json | undefined;
    const good =
      ok(r) && typeof info?.TradePrice === 'number' && typeof info?.Currency === 'string';
    return {
      planRef: req.planRef,
      providerRegionId: req.providerRegionId,
      price: good
        ? {
            amountMinor: toMinorUnits(info!.TradePrice as number, 'ceil'),
            currency: String(info!.Currency),
            period: 'hour',
          }
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
      case 'Running':
      case 'Stopping': // not yet stopped
        return 'running';
      case 'Stopped':
        return 'stopped';
      case 'Pending':
      case 'Starting':
        return 'provisioning';
      default:
        return 'error'; // anything undocumented
    }
  }
  private tagsOf(i: Json): Record<string, string> {
    const t: Record<string, string> = {};
    for (const x of this.arr(i.Tags?.Tag))
      if (typeof x.TagKey === 'string') t[x.TagKey as string] = String(x.TagValue ?? '');
    return t;
  }

  async provision(
    ctx: AccountContext,
    req: ProvisionRequest & { idempotencyToken: string },
  ): Promise<OperationResult<InstanceRef>> {
    const caps = await this.caps(ctx);
    if (!isSupported(caps, 'compute.provision'))
      return opUnsupported(this.evNow('provision', 'provision not supported'), 'compute.provision');
    const region = req.providerRegionId;
    if (!/^[a-z0-9-]{3,40}$/.test(region) || !this.countries[region])
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
        `no VSwitch/security group is configured for ${region}`,
      );
    if (req.sshPublicKeys.length > 1)
      return opFailCat(
        this.evNow('provision', 'multiple keys'),
        'validation',
        'single_key_only',
        'RunInstances accepts one KeyPairName; supply exactly one SSH public key',
      );
    if (!/^[0-9a-f]{64}$/.test(req.idempotencyToken))
      return opFailCat(
        this.evNow('provision', 'bad token'),
        'validation',
        'invalid_token',
        'idempotency token must be 64 hex characters',
      );
    // SSH key: ImportKeyPair under a name derived from the key (re-importing the same key is a no-op: KeyPair.AlreadyExist is success)
    let keyName: string | undefined;
    if (req.sshPublicKeys[0]) {
      keyName = `nuzm-${createHash('sha256').update(req.sshPublicKeys[0]).digest('hex').slice(0, 24)}`;
      const k = await this.rpc(ctx, {
        service: 'ecs',
        region,
        action: 'ImportKeyPair',
        params: { RegionId: region, KeyPairName: keyName, PublicKeyBody: req.sshPublicKeys[0] },
        mutating: true,
      });
      if (!ok(k) && k.code !== 'KeyPair.AlreadyExist')
        return k.ambiguous ? opUncertain(k.ev, k.ambiguous) : this.mutFail(k);
    }
    const tags: Record<string, string> = {
      ...req.tags,
      [TAG_TOKEN]: req.idempotencyToken,
      [TAG_ORG]: req.tags['nuzm-org'] ?? orgTag('unknown'),
    };
    const params: Record<string, string> = {
      RegionId: region,
      ImageId: req.imageRef,
      InstanceType: req.planRef,
      ClientToken: req.idempotencyToken,
      InstanceName: `nuzm-${req.name.replace(/[^A-Za-z0-9_.:-]/g, '-')}`.slice(0, 128),
      SecurityGroupId: net.securityGroupId,
      VSwitchId: net.vSwitchId,
      ...(net.zoneId ? { ZoneId: net.zoneId } : {}),
      Amount: '1',
      MinAmount: '1',
      InstanceChargeType: 'PostPaid',
      'SystemDisk.Category': this.disk.category,
      'SystemDisk.Size': String(req.diskGb ?? this.disk.sizeGb),
      InternetMaxBandwidthOut: String(this.o.internetMaxBandwidthOut ?? 5),
      ...(keyName ? { KeyPairName: keyName } : {}),
    };
    Object.entries(tags)
      .slice(0, 20)
      .forEach(([k, v], i) => {
        params[`Tag.${i + 1}.Key`] = k;
        params[`Tag.${i + 1}.Value`] = v;
      });
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region,
      action: 'RunInstances',
      params,
      mutating: true,
    });
    if (!ok(r)) return this.mutFail(r);
    const id =
      this.arr(r.json?.InstanceIdSets?.InstanceIdSet as unknown)[0] ??
      (Array.isArray(r.json?.InstanceIdSets?.InstanceIdSet)
        ? r.json!.InstanceIdSets.InstanceIdSet[0]
        : undefined);
    if (typeof id !== 'string')
      return opUncertain(r.ev, 'RunInstances answered 2xx without an instance id');
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
        'not an Alibaba instance reference',
      );
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: p.region,
      action: 'DescribeInstances',
      params: { RegionId: p.region, InstanceIds: JSON.stringify([p.instanceId]) },
    });
    if (!ok(r)) return this.readFail(r);
    const i = this.arr(r.json?.Instances?.Instance)[0];
    if (!i)
      return opFailCat(
        r.ev,
        'not_found',
        'InvalidInstanceId.NotFound',
        'instance not visible (not created yet, or released)',
      );
    const ips = [
      ...this.arr(i.PublicIpAddress?.IpAddress as unknown),
      ...(Array.isArray(i.PublicIpAddress?.IpAddress) ? i.PublicIpAddress.IpAddress : []),
    ].filter((x): x is string => typeof x === 'string');
    const eip =
      typeof i.EipAddress?.IpAddress === 'string' && i.EipAddress.IpAddress
        ? [i.EipAddress.IpAddress as string]
        : [];
    return opOk(
      r.ev,
      {
        providerRef: ref,
        status: this.statusOf(i.Status),
        providerRegionId: p.region,
        planRef: String(i.InstanceType ?? ''),
        publicIps: [...new Set([...ips, ...eip])],
        tags: this.tagsOf(i),
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
      regions = all.map((r) => r.providerRegionId);
    }
    let last: Reply | null = null;
    for (const region of regions) {
      const r = await this.rpc(ctx, {
        service: 'ecs',
        region,
        action: 'DescribeInstances',
        params: {
          RegionId: region,
          'Tag.1.Key': TAG_TOKEN,
          'Tag.1.Value': token,
          MaxResults: '10',
        },
      });
      last = r;
      if (!ok(r)) return this.readFail(r); // a region that cannot be searched means absence is NOT proven
      const hit = this.arr(r.json?.Instances?.Instance)[0];
      if (hit) {
        const ref = this.refOf(region, String(hit.InstanceId));
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
        'not an Alibaba instance reference',
      );
    const supplied: Record<string, string> =
      typeof params.idempotencyToken === 'string' && /^[0-9a-f]{64}$/.test(params.idempotencyToken)
        ? { ClientToken: params.idempotencyToken }
        : {};
    const call = async (a: string, extra: Record<string, string>) =>
      this.rpc(ctx, {
        service: 'ecs',
        region: p.region,
        action: a,
        params: { InstanceId: p.instanceId, ...extra },
        mutating: true,
      });
    const done = (r: Reply): OperationResult<void> => {
      if (r.code === 'InvalidInstanceId.NotFound')
        return opFailCat(r.ev, 'not_found', r.code, 'instance not found');
      return ok(r) ? opOk<void>(r.ev, undefined, ref, 'accepted') : this.mutFail(r);
    };
    switch (action) {
      case 'start':
        return done(await call('StartInstance', {}));
      case 'stop':
        return done(
          await call('StopInstance', { StoppedMode: 'StopCharging', ForceStop: 'false' }),
        );
      case 'reboot':
        return done(await call('RebootInstance', { ForceStop: 'false' }));
      case 'resize': {
        const target = typeof params.planRef === 'string' ? params.planRef : '';
        if (!/^ecs\.[A-Za-z0-9.-]+$/.test(target))
          return opFailCat(
            this.evNow('act.resize', 'bad target'),
            'validation',
            'invalid_plan',
            'params.planRef must be an ECS instance type',
          );
        const cur = await this.inspect(ctx, ref);
        if (cur.status !== 'succeeded') return cur as unknown as OperationResult<void>;
        if (cur.data!.status !== 'stopped')
          // docs: an instance-type change requires the instance to be Stopped
          return opFailCat(
            cur.raw,
            'conflict',
            'IncorrectInstanceStatus',
            'the instance must be stopped before its type can change',
          );
        return done(await call('ModifyInstanceSpec', { InstanceType: target, ...supplied }));
      }
      case 'snapshot': {
        const d = await this.rpc(ctx, {
          service: 'ecs',
          region: p.region,
          action: 'DescribeDisks',
          params: { RegionId: p.region, InstanceId: p.instanceId, DiskType: 'system' },
        });
        if (!ok(d)) return this.readFail(d);
        const disk = this.arr(d.json?.Disks?.Disk)[0];
        if (!disk?.DiskId)
          return opFailCat(
            d.ev,
            'not_found',
            'InvalidDiskId.NotFound',
            'no system disk found for the instance',
          );
        const name = `nuzm-snap-${Math.floor(this.now() / 1000)}`;
        const r = await this.rpc(ctx, {
          service: 'ecs',
          region: p.region,
          action: 'CreateSnapshot',
          params: { DiskId: String(disk.DiskId), SnapshotName: name, ...supplied },
          mutating: true,
        });
        return done(r);
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
        'not an Alibaba instance reference',
      );
    // Force=true releases a Running instance (docs: Force=false requires Stopped). Irreversible; callers guard with deletion_protected.
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: p.region,
      action: 'DeleteInstance',
      params: { InstanceId: p.instanceId, Force: 'true' },
      mutating: true,
    });
    if (r.code === 'InvalidInstanceId.NotFound') return opOk<void>(r.ev, undefined, ref); // already gone: idempotent
    return ok(r) ? opOk<void>(r.ev, undefined, ref) : this.mutFail(r);
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
        'not an Alibaba instance reference',
      );
    const span = (Date.parse(window.to) - Date.parse(window.from)) / 1000;
    const period = [60, 600, 3600].find((x) => span / x <= 400); // docs: (EndTime-StartTime)/Period <= 400; Period in {60, 600, 3600}
    if (!period || !(span > 0))
      return opFailCat(
        this.evNow('metrics', 'window'),
        'validation',
        'InvalidParameter.TooManyDataQueried',
        'window too large for the documented 400-point limit',
      );
    const r = await this.rpc(ctx, {
      service: 'ecs',
      region: p.region,
      action: 'DescribeInstanceMonitorData',
      params: {
        InstanceId: p.instanceId,
        StartTime: acsDate(Date.parse(window.from)),
        EndTime: acsDate(Date.parse(window.to)),
        Period: String(period),
      },
    });
    if (!ok(r)) return this.readFail(r);
    const rows = this.arr(r.json?.MonitorData?.InstanceMonitorData);
    // units per the DescribeInstanceMonitorData page: CPU percent; traffic kbits per period; BPS bytes/s; IOPS ops/s
    const defs: [string, string, string][] = [
      ['CPU', 'cpu', 'percent'],
      ['InternetRX', 'internet_rx', 'kbit'],
      ['InternetTX', 'internet_tx', 'kbit'],
      ['BPSRead', 'disk_read', 'bytes/s'],
      ['BPSWrite', 'disk_write', 'bytes/s'],
      ['IOPSRead', 'iops_read', 'ops/s'],
      ['IOPSWrite', 'iops_write', 'ops/s'],
    ];
    const series = defs.map(([field, name, unit]) => ({
      name,
      unit,
      points: rows
        .filter((x) => typeof x[field] === 'number')
        .map((x) => ({ t: String(x.TimeStamp), v: x[field] as number })),
    }));
    return opOk(r.ev, { window, series }, ref);
  }

  /** Provider cost capture (BSS DescribeInstanceBill). Amounts are major-unit JSON numbers → rounded to 2 decimals (minor units NOT DOCUMENTED). */
  async fetchBilling(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]> {
    const out: ProviderCostRecord[] = [];
    for (const cycle of monthsBetween(period.from, period.to)) {
      let next = '';
      for (let page = 0; page < 50; page++) {
        const r = await this.rpc(ctx, {
          service: 'bss',
          region: 'bss',
          action: 'DescribeInstanceBill',
          params: {
            BillingCycle: cycle,
            ProductCode: 'ecs',
            IsBillingItem: 'false',
            MaxResults: '300',
            ...(next ? { NextToken: next } : {}),
          },
        });
        if (!ok(r) || r.json?.Success === false)
          throw new Error(`DescribeInstanceBill failed: ${r.code ?? r.status}`);
        const data = (r.json?.Data ?? {}) as Json;
        // the docs show Items as a plain array on DescribeInstanceBill but as Items.Item[] on the sibling pages: accept both
        const items = Array.isArray(data.Items)
          ? (data.Items as Json[])
          : this.arr(data.Items?.Item);
        for (const it of items) {
          const amount = typeof it.PretaxAmount === 'number' ? (it.PretaxAmount as number) : null;
          const cur = typeof it.Currency === 'string' ? (it.Currency as string) : null;
          if (amount === null || !cur || amount < 0) continue;
          const [y, m] = cycle.split('-').map(Number) as [number, number];
          out.push({
            providerRef:
              typeof it.InstanceID === 'string' && it.InstanceID ? (it.InstanceID as string) : null,
            periodStart: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
            periodEnd: new Date(Date.UTC(y, m, 1)).toISOString(),
            amountMinor: toMinorUnits(amount, 'round'),
            currency: cur,
            description:
              `${String(it.ProductName ?? 'ECS')} ${String(it.InstanceSpec ?? '').trim()} ${String(it.BillingDate ?? '')}`.trim(),
          });
        }
        next = String(data.NextToken ?? '');
        if (!next) break;
      }
    }
    return out;
  }
}
