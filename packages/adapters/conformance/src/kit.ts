import {
  CAPABILITY_IDS,
  CONTRACT_VERSION,
  ERROR_CATEGORIES,
  actionCapability,
  idempotencyToken,
  isSupported,
  type AccountContext,
  type CapabilityId,
  type CapabilityState,
  type ComputeAdapter,
  type OperationResult,
  type ProvisionRequest,
} from '@nuzm/adapter-contracts';
import { GuardedCompute, type Clock } from '@nuzm/adapter-runtime';
import { Redactor } from '@nuzm/adapter-contracts';

/**
 * Conformance kit (docs/09 §1 rule 6, M05 S16 task 1). One shared suite every ComputeAdapter must pass against (a) recorded sandbox
 * fixtures and (b) a mock server in CI. A pass here says "our contract is honoured"; it never says "the vendor works" — live runs
 * are separate, human-triggered, and labelled LIVE-VERIFIED / NOT VERIFIED (CLAUDE.md §5).
 */
export interface ConformanceControls {
  /** Billable resources currently existing at the (simulated) provider. */
  billableCount(): number;
  billableByToken(token: string): number;
  advance(ms: number): void;
  /** Make the NEXT `times` calls of `op` fail in the way `kind` names (`timeout_after_side_effect`, `timeout_before_side_effect`, `rate_limit`, `outage`). */
  inject(op: string, kind: string, times?: number): void;
  setCapabilities(p: Partial<Record<CapabilityId, CapabilityState>>): void;
  setConsistencyLag?(ms: number): void;
}
export interface ConformanceSubject {
  adapter: ComputeAdapter;
  ctx: AccountContext;
  controls: ConformanceControls;
  clock: Clock;
  /** A region id the account lists, and a plan known to be available in it, and an image. */
  fixture: {
    providerRegionId: string;
    planRef: string;
    imageRef: string;
    unavailablePlanRef?: string;
  };
  /** Evidence kind the adapter emits for this run (`mock` for the simulator, `fixture` for recorded replays). */
  evidenceKind: 'mock' | 'fixture';
}
export interface ConformanceCase {
  id: string;
  title: string;
  run(s: ConformanceSubject): Promise<void>;
}
export interface CaseResult {
  id: string;
  title: string;
  status: 'pass' | 'fail';
  detail?: string;
}
export interface ConformanceReport {
  adapterId: string;
  contractVersion: string;
  evidenceKind: 'mock' | 'fixture';
  results: CaseResult[];
  passed: number;
  failed: number;
  total: number;
  /** Always `NOT VERIFIED`: a conformance pass on mock/fixtures is never live verification. */
  liveStatus: 'NOT VERIFIED';
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
const req = (s: ConformanceSubject, name = 'conformance-node'): ProvisionRequest => ({
  providerRegionId: s.fixture.providerRegionId,
  planRef: s.fixture.planRef,
  imageRef: s.fixture.imageRef,
  name,
  sshPublicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItestkeytestkeytestkeytestkey0000 test'],
  tags: { 'nuzm-org': 'conformance' },
});
const tok = (n: string) => idempotencyToken('org-conformance', `op-${n}`, 'provision');
const guarded = (s: ConformanceSubject, redactor = new Redactor()) =>
  new GuardedCompute({
    clock: s.clock,
    redactor,
    rate: { burst: 1000, perSecond: 1000 },
    breaker: { failureThreshold: 1000, cooldownMs: 1 },
  }).wrap(s.adapter);
const okRef = (r: OperationResult<{ providerRef: string } | null>): string => {
  check(
    r.status === 'succeeded' || r.status === 'accepted',
    `expected success, got ${r.status} ${r.error?.message ?? ''}`,
  );
  check(r.providerRef ?? r.data?.providerRef, 'a provider reference is required');
  return (r.providerRef ?? r.data!.providerRef) as string;
};

export const COMPUTE_CASES: ConformanceCase[] = [
  {
    id: 'C01',
    title: 'declares contract 1.0.0 and kind compute',
    async run(s) {
      check(
        s.adapter.contractVersion === CONTRACT_VERSION,
        `contractVersion ${s.adapter.contractVersion}`,
      );
      check(s.adapter.kind === 'compute', 'kind must be compute');
      check(s.adapter.id.length > 0, 'id required');
    },
  },
  {
    id: 'C02',
    title: 'probe reports every capability id, is side-effect free and evidence-backed',
    async run(s) {
      const before = s.controls.billableCount();
      const r = await s.adapter.probe(s.ctx);
      for (const id of CAPABILITY_IDS)
        check(r.capabilities[id] !== undefined, `probe omitted ${id}`);
      for (const [id, st] of Object.entries(r.capabilities)) {
        check(
          (CAPABILITY_IDS as readonly string[]).includes(id),
          `probe invented capability ${id}`,
        );
        check(['supported', 'unsupported', 'unknown'].includes(st), `bad state ${st}`);
      }
      check(r.evidence.length > 0, 'probe must return evidence');
      check(
        r.evidence.every((e) => e.kind === s.evidenceKind),
        `evidence kind must be ${s.evidenceKind}`,
      );
      check(Number.isFinite(Date.parse(r.probedAt)), 'probedAt must be an ISO time');
      check(s.controls.billableCount() === before, 'probe must not create or delete resources');
    },
  },
  {
    id: 'C03',
    title:
      'capability honesty: claimed supported ⇒ works; unsupported ⇒ rejected as unsupported (never silent)',
    async run(s) {
      const caps = (await s.adapter.probe(s.ctx)).capabilities;
      const a = guarded(s);
      const ref = isSupported(caps, 'compute.provision')
        ? okRef(
            await a.provision(s.ctx, { ...req(s, 'honesty'), idempotencyToken: tok('honesty') }),
          )
        : null;
      check(
        ref !== null || !isSupported(caps, 'compute.inspect'),
        'inspect claimed without provision cannot be exercised',
      );
      if (ref) {
        for (const act of ['reboot', 'stop', 'start', 'resize', 'snapshot'] as const) {
          const supported = isSupported(caps, actionCapability(act));
          if (!a.act) {
            check(!supported, `${act} claimed but adapter has no act()`);
            continue;
          }
          const params = act === 'resize' ? { planRef: s.fixture.planRef } : {};
          const r = await a.act(s.ctx, ref, act, params);
          if (supported)
            check(
              r.status === 'succeeded' || r.status === 'accepted',
              `${act} claimed but ${r.status}: ${r.error?.message}`,
            );
          else {
            check(
              r.status === 'failed' && r.error?.category === 'unsupported',
              `${act} not supported but returned ${r.status}/${r.error?.category}`,
            );
          }
        }
        if (a.metrics) {
          const m = await a.metrics(s.ctx, ref, {
            from: '2026-01-01T00:00:00Z',
            to: '2026-01-01T01:00:00Z',
          });
          if (isSupported(caps, 'compute.metrics'))
            check(m.status === 'succeeded', 'metrics claimed but failed');
          else
            check(
              m.status === 'failed' && m.error?.category === 'unsupported',
              'metrics not supported must fail as unsupported',
            );
        } else
          check(
            !isSupported(caps, 'compute.metrics'),
            'metrics claimed but adapter has no metrics()',
          );
        if (isSupported(caps, 'compute.inspect')) {
          const i = await a.inspect(s.ctx, ref);
          check(
            i.status === 'succeeded' && i.data?.providerRef === ref,
            'inspect claimed but did not return the resource',
          );
        }
        await a.delete(s.ctx, ref);
      }
    },
  },
  {
    id: 'C04',
    title:
      'catalog: ISO countries, integer-string prices (no floats), evidence for every verified region',
    async run(s) {
      const c = await s.adapter.catalog(s.ctx);
      check(c.regions.length > 0, 'fixture account must list a region');
      for (const r of c.regions) {
        check(/^[A-Z]{2}$/.test(r.countryCode), `bad country ${r.countryCode}`);
        if (r.verifiedAt)
          check(
            r.evidence.length > 0 && !Number.isNaN(Date.parse(r.verifiedAt)),
            `region ${r.providerRegionId} verified without evidence`,
          );
      }
      for (const p of c.plans) {
        check(
          Number.isInteger(p.vcpu) && Number.isInteger(p.memoryMb) && Number.isInteger(p.diskGb),
          'plan sizes must be integers',
        );
        if (p.price) {
          check(
            /^\d+$/.test(p.price.amountMinor),
            `price must be integer minor units, got ${p.price.amountMinor}`,
          );
          check(/^[A-Z]{3}$/.test(p.price.currency), 'currency must be ISO 4217');
        }
      }
      const listed = await s.adapter.listRegions(s.ctx);
      check(listed.length === c.regions.length, 'listRegions and catalog disagree');
    },
  },
  {
    id: 'C05',
    title: 'idempotent provision: a replayed token never creates a second billable resource',
    async run(s) {
      const token = tok('replay');
      const a = guarded(s);
      const r1 = okRef(await a.provision(s.ctx, { ...req(s, 'replay'), idempotencyToken: token }));
      const r2 = okRef(await a.provision(s.ctx, { ...req(s, 'replay'), idempotencyToken: token }));
      check(r1 === r2, 'a replay must return the same resource');
      check(
        s.controls.billableByToken(token) === 1,
        `billable resources for the token: ${s.controls.billableByToken(token)}`,
      );
      await a.delete(s.ctx, r1);
    },
  },
  {
    id: 'C06',
    title:
      'timeout AFTER the side effect is `uncertain`; findByToken locates the resource (no second create needed)',
    async run(s) {
      const token = tok('after');
      const a = guarded(s);
      s.controls.inject('provision', 'timeout_after_side_effect');
      const r = await a.provision(s.ctx, { ...req(s, 'after'), idempotencyToken: token });
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      check(s.controls.billableByToken(token) === 1, 'the side effect must have happened');
      const f = await a.findByToken(s.ctx, token);
      const ref = okRef(f as OperationResult<{ providerRef: string } | null>);
      check(!!ref, 'findByToken must locate the orphan');
      await a.delete(s.ctx, ref);
    },
  },
  {
    id: 'C07',
    title:
      'timeout BEFORE the side effect is `uncertain`; findByToken proves absence; a retry then yields exactly one resource',
    async run(s) {
      const token = tok('before');
      const a = guarded(s);
      s.controls.inject('provision', 'timeout_before_side_effect');
      const r = await a.provision(s.ctx, { ...req(s, 'before'), idempotencyToken: token });
      check(r.status === 'uncertain', `expected uncertain, got ${r.status}`);
      const f = await a.findByToken(s.ctx, token);
      check(
        f.status === 'succeeded' && f.data === null,
        'findByToken must prove absence with data:null',
      );
      const ref = okRef(await a.provision(s.ctx, { ...req(s, 'before'), idempotencyToken: token }));
      check(s.controls.billableByToken(token) === 1, 'exactly one resource after the retry');
      await a.delete(s.ctx, ref);
    },
  },
  {
    id: 'C08',
    title: 'delete is idempotent and a deleted resource is not billable',
    async run(s) {
      const a = guarded(s);
      const ref = okRef(
        await a.provision(s.ctx, { ...req(s, 'del'), idempotencyToken: tok('del') }),
      );
      const d1 = await a.delete(s.ctx, ref);
      const d2 = await a.delete(s.ctx, ref);
      check(
        d1.status === 'succeeded' && d2.status === 'succeeded',
        'delete twice must succeed twice',
      );
      check(s.controls.billableByToken(tok('del')) === 0, 'deleted resource must not be billable');
      const i = await a.inspect(s.ctx, ref);
      check(
        (i.status === 'succeeded' && i.data?.status === 'deleted') ||
          (i.status === 'failed' && i.error?.category === 'not_found'),
        'inspect of a deleted resource: deleted or not_found',
      );
    },
  },
  {
    id: 'C09',
    title:
      'an action the probe lists as unsupported is rejected as `unsupported` (never a silent no-op)',
    async run(s) {
      const a = guarded(s);
      const ref = okRef(
        await a.provision(s.ctx, { ...req(s, 'unsup'), idempotencyToken: tok('unsup') }),
      );
      s.controls.setCapabilities({
        'compute.action.snapshot': 'unsupported',
        'compute.action.resize': 'unknown',
      });
      check(!!a.act, 'adapter must implement act() when it can act at all');
      for (const act of ['snapshot', 'resize'] as const) {
        const r = await a.act!(s.ctx, ref, act, { planRef: s.fixture.planRef });
        check(
          r.status === 'failed' && r.error?.category === 'unsupported',
          `${act}: expected failed/unsupported, got ${r.status}/${r.error?.category}`,
        );
      }
      s.controls.setCapabilities({
        'compute.action.snapshot': 'supported',
        'compute.action.resize': 'supported',
      });
      await a.delete(s.ctx, ref);
    },
  },
  {
    id: 'C10',
    title:
      'errors are normalized (category from the table, boolean retryable, provider code, message)',
    async run(s) {
      const a = guarded(s);
      const bad = await a.provision(s.ctx, {
        ...req(s, 'bad'),
        providerRegionId: 'no-such-region',
        idempotencyToken: tok('bad'),
      });
      const nf = await a.inspect(s.ctx, 'no-such-resource');
      const cases: OperationResult<unknown>[] = [bad, nf];
      if (s.fixture.unavailablePlanRef)
        cases.push(
          await a.provision(s.ctx, {
            ...req(s, 'cap'),
            planRef: s.fixture.unavailablePlanRef,
            idempotencyToken: tok('cap'),
          }),
        );
      for (const r of cases) {
        check(r.status === 'failed' && !!r.error, 'expected a failed result with an error');
        const e = r.error!;
        check(
          (ERROR_CATEGORIES as string[]).includes(e.category),
          `category ${e.category} not in the table`,
        );
        check(
          typeof e.retryable === 'boolean' && e.providerCode.length > 0 && e.message.length > 0,
          'error fields incomplete',
        );
      }
      check(
        bad.error!.category === 'validation' && !bad.error!.retryable,
        'unknown region must be a non-retryable validation error',
      );
      check(nf.error!.category === 'not_found', 'unknown resource must be not_found');
      check(
        s.controls.billableByToken(tok('bad')) === 0,
        'a validation failure must not create anything',
      );
    },
  },
  {
    id: 'C11',
    title: 'rate limiting: a rate-limited call fails retryably and creates nothing',
    async run(s) {
      const a = guarded(s);
      s.controls.inject('provision', 'rate_limit');
      const r = await a.provision(s.ctx, { ...req(s, 'rl'), idempotencyToken: tok('rl') });
      check(
        r.status === 'failed' && r.error?.category === 'rate_limit' && r.error.retryable,
        `expected retryable rate_limit, got ${r.status}/${r.error?.category}`,
      );
      check(
        s.controls.billableByToken(tok('rl')) === 0,
        'a rate-limited call must not create anything',
      );
    },
  },
  {
    id: 'C12',
    title: 'lookup by token unsupported ⇒ `failed/unsupported` (absence can never be inferred)',
    async run(s) {
      s.controls.setCapabilities({ 'compute.find-by-token': 'unsupported' });
      const f = await guarded(s).findByToken(s.ctx, tok('nolookup'));
      check(
        f.status === 'failed' && f.error?.category === 'unsupported',
        `expected failed/unsupported, got ${f.status}`,
      );
      check(f.data === undefined, 'must not return data:null when lookup is unsupported');
      s.controls.setCapabilities({ 'compute.find-by-token': 'supported' });
    },
  },
  {
    id: 'C13',
    title:
      'eventual consistency: a fresh resource may be invisible (not_found / null) until it settles, then appears',
    async run(s) {
      if (!s.controls.setConsistencyLag) return; // subject cannot simulate lag
      const a = guarded(s);
      s.controls.setConsistencyLag(60_000);
      const token = tok('lag');
      const ref = okRef(await a.provision(s.ctx, { ...req(s, 'lag'), idempotencyToken: token }));
      const early = await a.inspect(s.ctx, ref);
      check(
        early.status === 'failed' && early.error?.category === 'not_found',
        'during the lag inspect answers not_found',
      );
      const earlyFind = await a.findByToken(s.ctx, token);
      check(
        earlyFind.status === 'succeeded' && earlyFind.data === null,
        'during the lag findByToken answers null (NOT proof of absence)',
      );
      s.controls.advance(61_000);
      const late = await a.inspect(s.ctx, ref);
      check(late.status === 'succeeded', 'after the lag inspect finds the resource');
      s.controls.setConsistencyLag(0);
      await a.delete(s.ctx, ref);
    },
  },
  {
    id: 'C14',
    title: 'secrets never appear in results or evidence (canary through the framework guard)',
    async run(s) {
      const canary = 'CANARY-5f3c9a77-NEVER-LEAK-0042';
      const redactor = new Redactor().register(canary);
      const a = guarded(s, redactor);
      const results: unknown[] = [];
      results.push(
        await a.provision(s.ctx, {
          ...req(s, `n-${canary}`),
          providerRegionId: `r-${canary}`,
          idempotencyToken: tok('canary'),
        }),
      );
      results.push(await a.inspect(s.ctx, `ref-${canary}`));
      results.push(await a.findByToken(s.ctx, `t-${canary}`));
      results.push(await a.delete(s.ctx, `ref-${canary}`));
      check(!redactor.leaks(results), 'a canary secret leaked into a result or evidence');
    },
  },
  {
    id: 'C15',
    title: 'idempotency token is deterministic: sha256(orgId|operationId|stepId)',
    async run() {
      check(
        idempotencyToken('o', 'p', 's') === idempotencyToken('o', 'p', 's'),
        'not deterministic',
      );
      check(
        idempotencyToken('o', 'p', 's') !== idempotencyToken('o', 'p', 't'),
        'step must change the token',
      );
      check(/^[0-9a-f]{64}$/.test(idempotencyToken('o', 'p', 's')), 'must be 64 hex chars');
    },
  },
];

export async function runComputeConformance(
  makeSubject: () => ConformanceSubject | Promise<ConformanceSubject>,
  cases: ConformanceCase[] = COMPUTE_CASES,
): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  let meta: ConformanceSubject | null = null;
  for (const c of cases) {
    const s = await makeSubject(); // a fresh subject per case: cases never share state
    meta ??= s;
    try {
      await c.run(s);
      results.push({ id: c.id, title: c.title, status: 'pass' });
    } catch (e) {
      results.push({ id: c.id, title: c.title, status: 'fail', detail: (e as Error).message });
    }
  }
  const passed = results.filter((r) => r.status === 'pass').length;
  return {
    adapterId: meta?.adapter.id ?? 'unknown',
    contractVersion: CONTRACT_VERSION,
    evidenceKind: meta?.evidenceKind ?? 'mock',
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    liveStatus: 'NOT VERIFIED',
  };
}

/** Minimal test-runner surface (vitest's describe/it/expect satisfy it) so the kit itself never imports a runner. */
export interface TestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect(v: unknown): { toBe(x: unknown): void };
}
/** Registers one test per conformance case for an adapter, plus a summary test that fails if any case failed. */
export function describeComputeConformance(
  t: TestApi,
  name: string,
  makeSubject: () => ConformanceSubject | Promise<ConformanceSubject>,
  onReport?: (r: ConformanceReport) => void,
): void {
  t.describe(`compute conformance: ${name}`, () => {
    for (const c of COMPUTE_CASES) {
      t.it(`${c.id} ${c.title}`, async () => {
        const report = await runComputeConformance(makeSubject, [c]);
        t.expect(report.results[0]?.detail ?? 'ok').toBe('ok');
      });
    }
    t.it('kit report: 100% of cases pass', async () => {
      const report = await runComputeConformance(makeSubject);
      onReport?.(report);
      t.expect(report.failed).toBe(0);
      t.expect(report.total).toBe(COMPUTE_CASES.length);
    });
  });
}
