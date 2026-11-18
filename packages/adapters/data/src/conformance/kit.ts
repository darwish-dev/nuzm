import type { AccountContext, CapabilityState, OperationResult } from '../upstream';
import { CONTRACT_VERSION, ERROR_CATEGORIES } from '../upstream';

/**
 * Conformance kit for the data/email adapters (docs/09 §1 rule 6, M08 S32 task 2). A pass says "our contract is honoured"; it NEVER says "the vendor
 * works": live runs are separate, human-triggered and tagged LIVE-VERIFIED or NOT VERIFIED (CLAUDE.md §5). `liveStatus` is therefore a constant.
 */
export interface ConformanceCase<S> {
  id: string;
  title: string;
  run(s: S): Promise<void>;
}
export interface CaseResult {
  id: string;
  title: string;
  status: 'pass' | 'fail';
  detail?: string;
}
export interface ConformanceReport {
  adapterId: string;
  kind: string;
  contractVersion: string;
  evidenceKind: 'mock' | 'fixture';
  results: CaseResult[];
  passed: number;
  failed: number;
  total: number;
  /** Always `NOT VERIFIED`: a pass on mock/fixtures is never live verification. */
  liveStatus: 'NOT VERIFIED';
}
export interface CommonControls {
  inject(
    op: string,
    kind: 'timeout_after_side_effect' | 'timeout_before_side_effect' | 'rate_limit' | 'outage',
    times?: number,
  ): void;
  billableCount(): number;
  billableByToken?(token: string): number;
}
export interface CommonSubject<A, C extends CommonControls> {
  adapter: A & {
    id: string;
    kind: string;
    contractVersion: string;
    probe(
      ctx: AccountContext,
    ): Promise<{ capabilities: Record<string, CapabilityState>; evidence: { kind: string }[] }>;
    health(ctx: AccountContext): Promise<{ state: string }>;
    catalog(
      ctx: AccountContext,
    ): Promise<{ regions: { verifiedAt: string | null }[]; plans: { price?: unknown }[] }>;
  };
  ctx: AccountContext;
  controls: C;
  evidenceKind: 'mock' | 'fixture';
}

export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
export const isOk = (r: OperationResult<unknown>) =>
  r.status === 'succeeded' || r.status === 'accepted';
export function expectOk<T>(r: OperationResult<T>, what: string): OperationResult<T> {
  check(isOk(r), `${what}: expected success, got ${r.status} ${r.error?.message ?? ''}`);
  return r;
}
export function expectUnsupported(r: OperationResult<unknown>, what: string): void {
  check(
    r.status === 'failed' && r.error?.category === 'unsupported',
    `${what}: an unsupported action must be failed/unsupported, got ${r.status}/${r.error?.category}`,
  );
}
export const noSecret = (r: OperationResult<unknown>, secrets: string[], what: string): void => {
  const blob = JSON.stringify(r.raw);
  for (const s of secrets)
    check(!blob.includes(s), `${what}: secret material leaked into evidence`);
};

/** Cases that are the same for every kind. */
export function commonCases<A, C extends CommonControls, S extends CommonSubject<A, C>>(
  kind: string,
  capIds: readonly string[],
): ConformanceCase<S>[] {
  return [
    {
      id: 'K01',
      title: `declares contract ${CONTRACT_VERSION} and kind ${kind}`,
      async run(s) {
        check(
          s.adapter.contractVersion === CONTRACT_VERSION,
          `contractVersion ${s.adapter.contractVersion}`,
        );
        check(s.adapter.kind === kind, `kind must be ${kind}`);
        check(s.adapter.id.length > 0, 'id required');
      },
    },
    {
      id: 'K02',
      title:
        'probe reports every capability id, is side-effect free and its evidence carries the run kind',
      async run(s) {
        const before = s.controls.billableCount();
        const r = await s.adapter.probe(s.ctx);
        for (const id of capIds) check(r.capabilities[id] !== undefined, `probe omitted ${id}`);
        for (const [id, st] of Object.entries(r.capabilities))
          check(['supported', 'unsupported', 'unknown'].includes(st), `bad state for ${id}`);
        check(r.evidence.length > 0, 'probe must return evidence');
        check(
          r.evidence.every((e) => e.kind === s.evidenceKind),
          `evidence must be tagged ${s.evidenceKind}`,
        );
        check(s.controls.billableCount() === before, 'probe must not create billable resources');
      },
    },
    {
      id: 'K03',
      title:
        'health and catalog are read-only; regions from a mock/fixture are never verified; a plan without a price carries no price',
      async run(s) {
        const before = s.controls.billableCount();
        const h = await s.adapter.health(s.ctx);
        check(['healthy', 'degraded', 'unhealthy', 'unknown'].includes(h.state), 'health state');
        const c = await s.adapter.catalog(s.ctx);
        check(
          c.regions.every((r) => r.verifiedAt === null),
          'a mock/fixture region must never be verified',
        );
        check(
          c.plans.every(
            (p) =>
              p.price === undefined ||
              typeof (p.price as { amountMinor: unknown }).amountMinor === 'string',
          ),
          'prices are integer-minor-unit strings',
        );
        check(s.controls.billableCount() === before, 'catalog must not create billable resources');
      },
    },
    {
      id: 'K04',
      title: 'normalized error categories are the documented ones',
      async run() {
        check(ERROR_CATEGORIES.length === 10, 'ten error categories (docs/09 §1 rule 4)');
      },
    },
  ];
}

export async function runConformance<
  S extends {
    evidenceKind: 'mock' | 'fixture';
    adapter: { id: string; kind: string; contractVersion: string };
  },
>(cases: ConformanceCase<S>[], subjectFactory: () => S | Promise<S>): Promise<ConformanceReport> {
  const results: CaseResult[] = [];
  let meta: S | undefined;
  for (const c of cases) {
    const s = await subjectFactory(); // a fresh simulator per case: cases never depend on each other
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
    adapterId: meta!.adapter.id,
    kind: meta!.adapter.kind,
    contractVersion: meta!.adapter.contractVersion,
    evidenceKind: meta!.evidenceKind,
    results,
    passed,
    failed: results.length - passed,
    total: results.length,
    liveStatus: 'NOT VERIFIED',
  };
}
