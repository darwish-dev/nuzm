import {
  CONTRACT_VERSION,
  COMPUTE_ACTIONS,
  actionCapability,
  completeCapabilities,
  isSupported,
  normalizedError,
  type AccountContext,
  type CapabilityId,
  type CapabilityReport,
  type CapabilityState,
  type CatalogSnapshot,
  type ComputeAction,
  type ComputeAdapter,
  type HealthReport,
  type InstanceRef,
  type InstanceState,
  type InstanceStatus,
  type Metrics,
  type OperationResult,
  type ProviderCostRecord,
  type ProviderImage,
  type ProviderPlan,
  type ProviderQuote,
  type ProviderRegion,
  type ProvisionRequest,
  type RawEvidence,
} from '@nuzm/adapter-contracts';
import { SimClock } from '@nuzm/adapter-runtime';

/**
 * `mock-compute`: a deterministic in-process simulator of a compute provider, with fault injection (M05 S16 task 2). It makes NO network
 * calls and every piece of evidence it emits is `kind: 'mock'`: nothing it does can ever support a LIVE-VERIFIED claim. It models only
 * behaviours our contract needs to be robust against; it says nothing about any real vendor.
 */
export type FaultOp =
  'provision' | 'inspect' | 'findByToken' | 'delete' | 'act' | 'catalog' | 'health';
export type FaultKind =
  | 'timeout_after_side_effect' // the effect happened, the caller sees `uncertain`
  | 'timeout_before_side_effect' // nothing happened, the caller sees `uncertain`
  | 'rate_limit' // definitive failure, retryable
  | 'outage' // definitive failure (provider_outage), retryable
  | 'duplicate_create'; // provision ignores the replayed token and creates a SECOND resource (a vendor without client-token dedupe)
export interface Fault {
  op: FaultOp;
  kind: FaultKind;
  /** How many matching calls it affects (default 1). */
  times?: number;
}

export interface MockRegionSpec {
  id: string;
  country: string;
  /** Listed in the account's region listing. Changing this simulates "region list changes". */
  listed: boolean;
}
export interface MockPlanSpec {
  planRef: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  /** Provider cost, integer minor units per hour. `null` = the vendor exposes no price (never offered). */
  hourlyMinor: string | null;
  currency: string;
  availability: 'available' | 'sold_out' | 'unavailable';
}
export interface MockInstance {
  ref: string;
  token: string;
  providerRegionId: string;
  planRef: string;
  imageRef: string;
  name: string;
  tags: Record<string, string>;
  status: InstanceStatus;
  createdAt: number;
  /** Eventual consistency: not visible to inspect/findByToken before this simulated time. */
  visibleAt: number;
  deleted: boolean;
  snapshots: number;
}

export interface MockComputeOptions {
  clock?: SimClock;
  regions?: MockRegionSpec[];
  plans?: MockPlanSpec[];
  /** The TRUE capability set of the simulated provider (what `probe()` reports). Default: everything except quote-api and billing-export. */
  capabilities?: Partial<Record<CapabilityId, CapabilityState>>;
  /** How long a created resource stays invisible to inspect/findByToken (simulated ms). Default 0. */
  consistencyLagMs?: number;
  /** Does the simulated vendor dedupe on the idempotency token? Default true. */
  dedupeTokens?: boolean;
}

export const DEFAULT_MOCK_REGIONS: MockRegionSpec[] = [
  { id: 'mock-eu-1', country: 'DE', listed: true },
  { id: 'mock-sa-1', country: 'SA', listed: true },
  { id: 'mock-us-1', country: 'US', listed: false },
];
export const DEFAULT_MOCK_PLANS: MockPlanSpec[] = [
  {
    planRef: 'mock.small',
    vcpu: 1,
    memoryMb: 2048,
    diskGb: 40,
    hourlyMinor: '12',
    currency: 'SAR',
    availability: 'available',
  },
  {
    planRef: 'mock.medium',
    vcpu: 2,
    memoryMb: 4096,
    diskGb: 80,
    hourlyMinor: '24',
    currency: 'SAR',
    availability: 'available',
  },
  {
    planRef: 'mock.large',
    vcpu: 4,
    memoryMb: 8192,
    diskGb: 160,
    hourlyMinor: '48',
    currency: 'SAR',
    availability: 'sold_out',
  },
];
export const DEFAULT_MOCK_CAPABILITIES: Partial<Record<CapabilityId, CapabilityState>> = {
  'compute.provision': 'supported',
  'compute.inspect': 'supported',
  'compute.delete': 'supported',
  'compute.find-by-token': 'supported',
  'compute.action.start': 'supported',
  'compute.action.stop': 'supported',
  'compute.action.reboot': 'supported',
  'compute.action.resize': 'supported',
  'compute.action.snapshot': 'supported',
  'compute.metrics': 'supported',
  'compute.billing-export': 'supported',
  'compute.quote-api': 'unsupported',
};

export class MockComputeAdapter implements ComputeAdapter {
  readonly id = 'mock-compute';
  readonly kind = 'compute' as const;
  readonly contractVersion = CONTRACT_VERSION;
  readonly clock: SimClock;
  readonly instances = new Map<string, MockInstance>();
  private regions: MockRegionSpec[];
  private plans: MockPlanSpec[];
  private caps: Record<CapabilityId, CapabilityState>;
  private faults: (Fault & { left: number })[] = [];
  private seq = 0;
  private lagMs: number;
  private readonly dedupe: boolean;
  /** Every call made, for assertions: `provision` calls are what a duplicate-resource test counts. */
  readonly calls: { op: string; at: number }[] = [];

  constructor(o: MockComputeOptions = {}) {
    this.clock = o.clock ?? new SimClock();
    this.regions = (o.regions ?? DEFAULT_MOCK_REGIONS).map((r) => ({ ...r }));
    this.plans = (o.plans ?? DEFAULT_MOCK_PLANS).map((p) => ({ ...p }));
    this.caps = completeCapabilities({ ...DEFAULT_MOCK_CAPABILITIES, ...(o.capabilities ?? {}) });
    this.lagMs = o.consistencyLagMs ?? 0;
    this.dedupe = o.dedupeTokens ?? true;
  }

  // ---- test control surface (not part of the contract) ---------------------------------------------------------------------
  inject(f: Fault): this {
    this.faults.push({ ...f, left: f.times ?? 1 });
    return this;
  }
  setCapabilities(p: Partial<Record<CapabilityId, CapabilityState>>): this {
    this.caps = completeCapabilities({ ...this.caps, ...p });
    return this;
  }
  setRegions(r: MockRegionSpec[]): this {
    this.regions = r.map((x) => ({ ...x }));
    return this;
  }
  setConsistencyLag(ms: number): this {
    this.lagMs = ms;
    return this;
  }
  setPlans(p: MockPlanSpec[]): this {
    this.plans = p.map((x) => ({ ...x }));
    return this;
  }
  setPrice(planRef: string, hourlyMinor: string | null): this {
    const p = this.plans.find((x) => x.planRef === planRef);
    if (p) p.hourlyMinor = hourlyMinor;
    return this;
  }
  /** Billable = exists at the provider and is not deleted (what a bill would charge for). */
  billableCount(): number {
    return [...this.instances.values()].filter((i) => !i.deleted).length;
  }
  billableByToken(token: string): number {
    return [...this.instances.values()].filter((i) => !i.deleted && i.token === token).length;
  }
  provisionCalls(): number {
    return this.calls.filter((c) => c.op === 'provision').length;
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------
  private ev(op: string, summary: string, extra: Record<string, unknown> = {}): RawEvidence {
    return {
      kind: 'mock',
      capturedAt: this.clock.iso(),
      operation: op,
      summary,
      redactedResponse: extra,
    };
  }
  private take(op: FaultOp): FaultKind | null {
    const f = this.faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left -= 1;
    return f.kind;
  }
  private fail<T>(
    op: string,
    category: Parameters<typeof normalizedError>[0],
    code: string,
    msg: string,
  ): OperationResult<T> {
    return {
      status: 'failed',
      error: normalizedError(category, code, msg),
      raw: this.ev(op, `${code}: ${msg}`),
    };
  }
  private uncertain<T>(op: string, why: string): OperationResult<T> {
    return {
      status: 'uncertain',
      error: normalizedError('provider_outage', 'timeout', `timed out (${why})`, true),
      raw: this.ev(op, `timeout (${why})`),
    };
  }
  /** Consumes the next fault for `op`. `rate_limit` and `outage` answer immediately; the other kinds are returned for the operation to apply. */
  private gate<T>(op: FaultOp): [OperationResult<T> | null, FaultKind | null] {
    this.calls.push({ op, at: this.clock.now() });
    const k = this.take(op);
    if (k === 'rate_limit')
      return [this.fail(op, 'rate_limit', 'mock_rate_limited', 'too many requests'), k];
    if (k === 'outage')
      return [this.fail(op, 'provider_outage', 'mock_outage', 'provider unavailable'), k];
    return [null, k];
  }
  private visible(i: MockInstance): boolean {
    return i.visibleAt <= this.clock.now();
  }
  private state(i: MockInstance): InstanceState {
    return {
      providerRef: i.ref,
      status: i.deleted ? 'deleted' : i.status,
      providerRegionId: i.providerRegionId,
      planRef: i.planRef,
      publicIps: i.deleted ? [] : [`192.0.2.${(Number(i.ref.split('-').pop()) % 250) + 1}`], // TEST-NET-1 documentation addresses
      tags: i.tags,
      observedAt: this.clock.iso(),
    };
  }

  // ---- AdapterBase ---------------------------------------------------------------------------------------------------------
  async probe(_ctx: AccountContext): Promise<CapabilityReport> {
    this.calls.push({ op: 'probe', at: this.clock.now() });
    return {
      capabilities: { ...this.caps },
      evidence: [this.ev('probe', 'mock capability set (simulator truth, not a vendor claim)')],
      probedAt: this.clock.iso(),
    };
  }
  async health(_ctx: AccountContext): Promise<HealthReport> {
    const k = this.take('health');
    this.calls.push({ op: 'health', at: this.clock.now() });
    if (k === 'outage' || k === 'timeout_before_side_effect' || k === 'timeout_after_side_effect')
      return { state: 'unhealthy', checkedAt: this.clock.iso(), detail: 'mock outage' };
    if (k === 'rate_limit')
      return { state: 'degraded', checkedAt: this.clock.iso(), detail: 'mock rate limited' };
    return { state: 'healthy', checkedAt: this.clock.iso(), latencyMs: 1 };
  }
  async listRegions(_ctx: AccountContext): Promise<ProviderRegion[]> {
    this.calls.push({ op: 'listRegions', at: this.clock.now() });
    const at = this.clock.iso();
    return this.regions
      .filter((r) => r.listed)
      .map((r) => ({
        providerRegionId: r.id,
        countryCode: r.country,
        displayName: r.id,
        verifiedAt: at,
        evidence: [this.ev('listRegions', `region ${r.id} present in the mock account listing`)],
      }));
  }
  async listPlans(_ctx: AccountContext, region: string): Promise<ProviderPlan[]> {
    this.calls.push({ op: 'listPlans', at: this.clock.now() });
    if (!this.regions.some((r) => r.id === region && r.listed)) return [];
    return this.plans.map((p) => ({
      planRef: p.planRef,
      providerRegionId: region,
      vcpu: p.vcpu,
      memoryMb: p.memoryMb,
      diskGb: p.diskGb,
      availability: p.availability,
      ...(p.hourlyMinor === null
        ? {}
        : { price: { amountMinor: p.hourlyMinor, currency: p.currency, period: 'hour' as const } }),
    }));
  }
  async listImages(_ctx: AccountContext, region: string): Promise<ProviderImage[]> {
    this.calls.push({ op: 'listImages', at: this.clock.now() });
    if (!this.regions.some((r) => r.id === region && r.listed)) return [];
    return [
      { imageRef: 'mock-ubuntu', providerRegionId: region, name: 'Mock Ubuntu', osFamily: 'linux' },
      { imageRef: 'mock-debian', providerRegionId: region, name: 'Mock Debian', osFamily: 'linux' },
    ];
  }
  async catalog(ctx: AccountContext): Promise<CatalogSnapshot> {
    const k = this.take('catalog');
    if (k === 'outage' || k === 'timeout_before_side_effect' || k === 'timeout_after_side_effect')
      throw new Error('mock catalog unavailable');
    const regions = await this.listRegions(ctx);
    const plans: ProviderPlan[] = [];
    const images: ProviderImage[] = [];
    for (const r of regions) {
      plans.push(...(await this.listPlans(ctx, r.providerRegionId)));
      images.push(...(await this.listImages(ctx, r.providerRegionId)));
    }
    return {
      takenAt: this.clock.iso(),
      regions,
      plans,
      images,
      evidence: [this.ev('catalog', `${regions.length} region(s), ${plans.length} plan(s)`)],
    };
  }
  async quote(_ctx: AccountContext, req: ProvisionRequest): Promise<ProviderQuote> {
    const p = this.plans.find((x) => x.planRef === req.planRef);
    return {
      planRef: req.planRef,
      providerRegionId: req.providerRegionId,
      price:
        p && p.hourlyMinor !== null
          ? { amountMinor: p.hourlyMinor, currency: p.currency, period: 'hour' }
          : null,
      derivedFromCatalog: true,
    };
  }

  // ---- mutating operations -------------------------------------------------------------------------------------------------
  async provision(
    _ctx: AccountContext,
    req: ProvisionRequest & { idempotencyToken: string },
  ): Promise<OperationResult<InstanceRef>> {
    const [g, kind] = this.gate<InstanceRef>('provision');
    if (g) return g;
    if (!isSupported(this.caps, 'compute.provision'))
      return this.fail('provision', 'unsupported', 'unsupported', 'provisioning is not supported');
    if (kind === 'timeout_before_side_effect')
      return this.uncertain('provision', 'before side effect');
    const region = this.regions.find((r) => r.id === req.providerRegionId && r.listed);
    if (!region)
      return this.fail(
        'provision',
        'validation',
        'region_not_listed',
        `region ${req.providerRegionId} is not in the account listing`,
      );
    const plan = this.plans.find((p) => p.planRef === req.planRef);
    if (!plan) return this.fail('provision', 'validation', 'plan_unknown', 'plan does not exist');
    if (plan.availability !== 'available')
      return this.fail('provision', 'capacity', 'plan_unavailable', 'plan is not available');
    const existing = [...this.instances.values()].find(
      (i) => i.token === req.idempotencyToken && !i.deleted,
    );
    if (existing && this.dedupe && kind !== 'duplicate_create') {
      const r: OperationResult<InstanceRef> = {
        status: 'succeeded',
        providerRef: existing.ref,
        data: { providerRef: existing.ref },
        raw: this.ev('provision', 'replayed token: existing resource returned'),
      };
      return r;
    }
    const ref = `mock-i-${++this.seq}`;
    this.instances.set(ref, {
      ref,
      token: req.idempotencyToken,
      providerRegionId: req.providerRegionId,
      planRef: req.planRef,
      imageRef: req.imageRef,
      name: req.name,
      tags: { ...req.tags, 'nuzm-token': req.idempotencyToken },
      status: 'running',
      createdAt: this.clock.now(),
      visibleAt: this.clock.now() + this.lagMs,
      deleted: false,
      snapshots: 0,
    });
    if (kind === 'timeout_after_side_effect')
      return this.uncertain('provision', 'after side effect');
    return {
      status: 'succeeded',
      providerRef: ref,
      data: { providerRef: ref },
      raw: this.ev('provision', `created ${ref}`),
    };
  }

  async inspect(_ctx: AccountContext, ref: string): Promise<OperationResult<InstanceState>> {
    const [g, kind] = this.gate<InstanceState>('inspect');
    if (g) return g;
    if (!isSupported(this.caps, 'compute.inspect'))
      return this.fail('inspect', 'unsupported', 'unsupported', 'inspect is not supported');
    if (kind === 'timeout_before_side_effect') return this.uncertain('inspect', 'read timeout');
    const i = this.instances.get(ref);
    if (!i || !this.visible(i))
      return this.fail('inspect', 'not_found', 'not_found', 'resource not found');
    return {
      status: 'succeeded',
      providerRef: ref,
      data: this.state(i),
      raw: this.ev('inspect', `${ref} ${i.deleted ? 'deleted' : i.status}`),
    };
  }

  async findByToken(
    _ctx: AccountContext,
    token: string,
  ): Promise<OperationResult<InstanceRef | null>> {
    const [g, kind] = this.gate<InstanceRef | null>('findByToken');
    if (g) return g;
    if (!isSupported(this.caps, 'compute.find-by-token'))
      return this.fail(
        'findByToken',
        'unsupported',
        'unsupported',
        'lookup by token is not supported',
      );
    if (kind === 'timeout_before_side_effect') return this.uncertain('findByToken', 'read timeout');
    const i = [...this.instances.values()].find(
      (x) => x.token === token && !x.deleted && this.visible(x),
    );
    return {
      status: 'succeeded',
      ...(i ? { providerRef: i.ref } : {}),
      data: i ? { providerRef: i.ref } : null,
      raw: this.ev(
        'findByToken',
        i ? `found ${i.ref}` : 'no resource carries this token (as visible now)',
      ),
    };
  }

  async act(
    _ctx: AccountContext,
    ref: string,
    action: ComputeAction,
    params: Record<string, unknown>,
  ): Promise<OperationResult<void>> {
    const [g, kind] = this.gate<void>('act');
    if (g) return g;
    if (!COMPUTE_ACTIONS.includes(action))
      return this.fail('act', 'validation', 'unknown_action', 'unknown action');
    if (!isSupported(this.caps, actionCapability(action)))
      return this.fail('act', 'unsupported', 'unsupported', `action ${action} is not supported`);
    if (kind === 'timeout_before_side_effect') return this.uncertain('act', 'before side effect');
    const i = this.instances.get(ref);
    if (!i || i.deleted || !this.visible(i))
      return this.fail('act', 'not_found', 'not_found', 'resource not found');
    if (action === 'start') i.status = 'running';
    else if (action === 'stop') i.status = 'stopped';
    else if (action === 'reboot') {
      if (i.status !== 'running')
        return this.fail('act', 'conflict', 'invalid_state', 'instance must be running to reboot');
    } else if (action === 'resize') {
      const target = typeof params.planRef === 'string' ? params.planRef : '';
      if (!this.plans.some((p) => p.planRef === target && p.availability === 'available'))
        return this.fail('act', 'validation', 'plan_unavailable', 'target plan is not available');
      i.planRef = target;
    } else if (action === 'snapshot') i.snapshots += 1;
    if (kind === 'timeout_after_side_effect') return this.uncertain('act', 'after side effect');
    return { status: 'succeeded', providerRef: ref, raw: this.ev('act', `${action} ${ref}`) };
  }

  async delete(_ctx: AccountContext, ref: string): Promise<OperationResult<void>> {
    const [g, kind] = this.gate<void>('delete');
    if (g) return g;
    if (!isSupported(this.caps, 'compute.delete'))
      return this.fail('delete', 'unsupported', 'unsupported', 'delete is not supported');
    if (kind === 'timeout_before_side_effect')
      return this.uncertain('delete', 'before side effect');
    const i = this.instances.get(ref);
    if (i && !i.deleted) i.deleted = true; // idempotent: deleting a deleted or unknown resource also succeeds
    if (kind === 'timeout_after_side_effect') return this.uncertain('delete', 'after side effect');
    return {
      status: 'succeeded',
      providerRef: ref,
      raw: this.ev('delete', i ? `deleted ${ref}` : `${ref} already absent`),
    };
  }

  async metrics(
    _ctx: AccountContext,
    ref: string,
    window: { from: string; to: string },
  ): Promise<OperationResult<Metrics>> {
    this.calls.push({ op: 'metrics', at: this.clock.now() });
    if (!isSupported(this.caps, 'compute.metrics'))
      return this.fail('metrics', 'unsupported', 'unsupported', 'metrics are not supported');
    const i = this.instances.get(ref);
    if (!i || i.deleted)
      return this.fail('metrics', 'not_found', 'not_found', 'resource not found');
    return {
      status: 'succeeded',
      providerRef: ref,
      data: {
        window,
        series: [
          {
            name: 'cpu_utilization',
            unit: 'percent',
            points: [
              { t: window.from, v: 10 },
              { t: window.to, v: 12 },
            ],
          },
        ],
      },
      raw: this.ev('metrics', `metrics for ${ref}`),
    };
  }

  async fetchBilling(
    _ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]> {
    if (!isSupported(this.caps, 'compute.billing-export'))
      throw new Error('billing export is not supported');
    const from = Date.parse(period.from);
    const to = Date.parse(period.to);
    const out: ProviderCostRecord[] = [];
    for (const i of this.instances.values()) {
      const plan = this.plans.find((p) => p.planRef === i.planRef);
      if (!plan || plan.hourlyMinor === null) continue;
      const start = Math.max(from, i.createdAt);
      if (start >= to) continue;
      const hours = Math.ceil((to - start) / 3_600_000);
      out.push({
        providerRef: i.ref,
        periodStart: new Date(start).toISOString(),
        periodEnd: period.to,
        amountMinor: (BigInt(plan.hourlyMinor) * BigInt(hours)).toString(),
        currency: plan.currency,
        description: `mock instance ${i.ref} (${hours} h)`,
      });
    }
    return out;
  }
}
