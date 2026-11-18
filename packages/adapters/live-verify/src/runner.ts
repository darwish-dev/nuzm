import {
  isSupported,
  actionCapability,
  idempotencyToken,
  orgTag,
  type AccountContext,
  type CapabilityId,
  type ComputeAdapter,
  type EvidenceKind,
  type RawEvidence,
} from '@nuzm/adapter-contracts';

/**
 * Live-verification runner (LV-1..LV-6, M05 §5). HUMAN-TRIGGERED ONLY: without an owner trigger carrying the HG evidence id and a spend
 * cap, `runLiveVerification` does nothing and returns `NOT RUN`. The agent never supplies a trigger. A run over non-live evidence (mock,
 * fixture, loopback) completes its steps but is labelled `NOT VERIFIED`; only an all-live run with a clean teardown is `LIVE-VERIFIED`.
 */
export interface OwnerTrigger {
  hgId: 'HG-05-01' | 'HG-05-02' | 'HG-05-03' | 'HG-05-04';
  /** Owner-recorded evidence reference for the gate (an id in docs/reports/evidence-index.md). */
  evidenceId: string;
  spendCapMinor: number;
  currency: string;
}
export interface LvTarget {
  providerRegionId: string;
  planRef: string;
  imageRef: string;
  /** Upper bound of the cost of this run (e.g. one hour of the smallest plan), integer minor units of `currency`. */
  estimatedCostMinor: number;
  currency: string;
  sshPublicKey: string;
  /** If set and `compute.action.resize` is supported, the instance is resized to it (the plan should be the next size up). */
  resizeToPlanRef?: string;
}
export interface LvStep {
  step: string;
  status: 'pass' | 'fail' | 'skipped';
  detail?: string;
  evidenceKind?: EvidenceKind;
}
export interface LvResult {
  jobId: string;
  status: 'NOT RUN' | 'LIVE-VERIFIED' | 'NOT VERIFIED' | 'FAIL';
  reason: string;
  steps: LvStep[];
  /** Capabilities exercised successfully (a capability is only worth recording as live-supported when the whole run is LIVE-VERIFIED). */
  exercised: CapabilityId[];
  residualResources: number;
  pageOwner: boolean;
  evidence: RawEvidence[];
}
export interface LvOptions {
  jobId: string;
  adapter: ComputeAdapter;
  ctx: AccountContext;
  trigger?: OwnerTrigger;
  target: LvTarget;
  orgId?: string;
  now?: () => number;
  /** Waits between polls (injectable so tests do not sleep). */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

export async function runLiveVerification(o: LvOptions): Promise<LvResult> {
  const steps: LvStep[] = [];
  const evidence: RawEvidence[] = [];
  const exercised: CapabilityId[] = [];
  const base = (
    status: LvResult['status'],
    reason: string,
    extra: Partial<LvResult> = {},
  ): LvResult => ({
    jobId: o.jobId,
    status,
    reason,
    steps,
    exercised,
    residualResources: 0,
    pageOwner: false,
    evidence,
    ...extra,
  });
  // LV-1: owner trigger, spend cap
  if (!o.trigger)
    return base('NOT RUN', 'no owner trigger: live verification is human-triggered only (LV-1)');
  if (!o.trigger.evidenceId || !/^[A-Za-z0-9._:-]{3,120}$/.test(o.trigger.evidenceId))
    return base('NOT RUN', 'owner trigger lacks an HG evidence id');
  if (!(o.trigger.spendCapMinor > 0) || o.trigger.currency !== o.target.currency)
    return base('NOT RUN', 'spend cap missing or in another currency');
  if (o.target.estimatedCostMinor > o.trigger.spendCapMinor)
    return base(
      'NOT RUN',
      `estimated cost ${o.target.estimatedCostMinor} exceeds the spend cap ${o.trigger.spendCapMinor}`,
    );
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const poll = async <T>(f: () => Promise<T | null>): Promise<T | null> => {
    for (let n = 0; n < (o.maxPolls ?? 30); n++) {
      const v = await f();
      if (v !== null) return v;
      await sleep(o.pollMs ?? 5000);
    }
    return null;
  };
  const note = (e: RawEvidence | undefined) => e && evidence.push(e);
  const step = async (
    name: string,
    f: () => Promise<{ ok: boolean; detail?: string; ev?: RawEvidence }>,
  ) => {
    try {
      const r = await f();
      note(r.ev);
      steps.push({
        step: name,
        status: r.ok ? 'pass' : 'fail',
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.ev ? { evidenceKind: r.ev.kind } : {}),
      });
      return r.ok;
    } catch (e) {
      steps.push({ step: name, status: 'fail', detail: (e as Error).message.slice(0, 300) });
      return false;
    }
  };
  const opId = `lv-${o.jobId}`;
  const token = idempotencyToken(o.orgId ?? 'org-live-verify', opId, 'provision');
  const tags = { 'nuzm-org': orgTag(o.orgId ?? 'org-live-verify'), 'nuzm-live-verify': o.jobId }; // LV-2: tagged resources
  let ref: string | null = null;
  let caps: Awaited<ReturnType<ComputeAdapter['probe']>>['capabilities'] | null = null;

  // LV-3: probe → create → inspect → actions → snapshot → delete → billing
  if (
    !(await step('probe', async () => {
      const p = await o.adapter.probe(o.ctx);
      caps = p.capabilities;
      p.evidence.forEach(note);
      return { ok: true };
    }))
  )
    return finish();
  const c = caps!;
  if (
    await step('provision', async () => {
      if (!isSupported(c, 'compute.provision'))
        return { ok: false, detail: 'compute.provision is not supported by the probe' };
      const r = await o.adapter.provision(o.ctx, {
        providerRegionId: o.target.providerRegionId,
        planRef: o.target.planRef,
        imageRef: o.target.imageRef,
        name: `lv-${o.jobId}`.slice(0, 40),
        sshPublicKeys: [o.target.sshPublicKey],
        tags,
        idempotencyToken: token,
      });
      if (r.status === 'uncertain') {
        const f = await o.adapter.findByToken(o.ctx, token); // reconcile before anything else
        ref = f.data?.providerRef ?? null;
      } else if (r.status === 'succeeded' || r.status === 'accepted') ref = r.providerRef ?? null;
      if (ref) exercised.push('compute.provision');
      return {
        ok: !!ref,
        detail: ref ? undefined : `provision ${r.status}: ${r.error?.message ?? ''}`,
        ev: r.raw,
      };
    })
  ) {
    await step('inspect', async () => {
      const s = await poll(async () => {
        const r = await o.adapter.inspect(o.ctx, ref!);
        note(r.raw);
        return r.status === 'succeeded' && r.data!.status === 'running' ? r : null;
      });
      if (s) exercised.push('compute.inspect');
      return { ok: !!s, detail: s ? undefined : 'instance never reached running', ev: s?.raw };
    });
    for (const a of ['stop', 'start', 'reboot'] as const) {
      if (!isSupported(c, actionCapability(a))) {
        steps.push({
          step: `action.${a}`,
          status: 'skipped',
          detail: 'not supported by the probe',
        });
        continue;
      }
      await step(`action.${a}`, async () => {
        const r = await o.adapter.act!(o.ctx, ref!, a, {});
        const good = r.status === 'succeeded' || r.status === 'accepted';
        if (good) exercised.push(actionCapability(a));
        if (good)
          await poll(async () => {
            const i = await o.adapter.inspect(o.ctx, ref!);
            return i.status === 'succeeded' &&
              i.data!.status === (a === 'stop' ? 'stopped' : 'running')
              ? i
              : null;
          });
        return {
          ok: good,
          detail: good ? undefined : `${a}: ${r.error?.message ?? r.status}`,
          ev: r.raw,
        };
      });
    }
    if (o.target.resizeToPlanRef && isSupported(c, 'compute.action.resize')) {
      await step('action.resize', async () => {
        await o.adapter.act!(o.ctx, ref!, 'stop', {});
        await poll(async () => {
          const i = await o.adapter.inspect(o.ctx, ref!);
          return i.status === 'succeeded' && i.data!.status === 'stopped' ? i : null;
        });
        const r = await o.adapter.act!(o.ctx, ref!, 'resize', {
          planRef: o.target.resizeToPlanRef,
        });
        const good = r.status === 'succeeded' || r.status === 'accepted';
        if (good) exercised.push('compute.action.resize');
        return { ok: good, detail: good ? undefined : r.error?.message, ev: r.raw };
      });
    } else
      steps.push({
        step: 'action.resize',
        status: 'skipped',
        detail: 'not requested or not supported',
      });
    if (isSupported(c, 'compute.action.snapshot')) {
      await step('action.snapshot', async () => {
        const r = await o.adapter.act!(o.ctx, ref!, 'snapshot', {});
        const good = r.status === 'succeeded' || r.status === 'accepted';
        if (good) exercised.push('compute.action.snapshot');
        return { ok: good, detail: good ? undefined : r.error?.message, ev: r.raw };
      });
    } else
      steps.push({
        step: 'action.snapshot',
        status: 'skipped',
        detail: 'not supported by the probe',
      });
    if (o.adapter.metrics && isSupported(c, 'compute.metrics')) {
      await step('metrics', async () => {
        const to = new Date((o.now ?? Date.now)()).toISOString();
        const from = new Date((o.now ?? Date.now)() - 30 * 60_000).toISOString();
        const r = await o.adapter.metrics!(o.ctx, ref!, { from, to });
        if (r.status === 'succeeded') exercised.push('compute.metrics');
        return { ok: r.status === 'succeeded', detail: r.error?.message, ev: r.raw };
      });
    }
    // delete (always attempted, even if a step above failed: LV-4 needs zero residue)
    await step('delete', async () => {
      const r = await o.adapter.delete(o.ctx, ref!);
      const good = r.status === 'succeeded' || r.status === 'accepted';
      if (good) exercised.push('compute.delete');
      return {
        ok: good,
        detail: good ? undefined : `delete ${r.status}: ${r.error?.message ?? ''}`,
        ev: r.raw,
      };
    });
  }
  return finish();

  async function finish(): Promise<LvResult> {
    // LV-4 teardown verifier: the token must find nothing live and the reference must not be running
    let residual = 0;
    try {
      if (isSupported(c0(), 'compute.find-by-token') || ref) {
        const f = await poll(async () => {
          const r = await o.adapter.findByToken(o.ctx, token);
          if (r.status !== 'succeeded') return null;
          if (r.data === null) return { gone: true };
          const i = await o.adapter.inspect(o.ctx, r.data!.providerRef);
          return (i.status === 'failed' && i.error?.category === 'not_found') ||
            (i.status === 'succeeded' && i.data!.status === 'deleted')
            ? { gone: true }
            : null;
        });
        residual = f ? 0 : 1;
      }
    } catch {
      residual = 1;
    }
    steps.push({
      step: 'teardown-verifier',
      status: residual === 0 ? 'pass' : 'fail',
      detail: residual ? 'a resource tagged for this run may still exist' : undefined,
    });
    if (o.adapter.fetchBilling && isSupported(c0(), 'compute.billing-export')) {
      await step('billing-record', async () => {
        const now = (o.now ?? Date.now)();
        const rows = await o.adapter.fetchBilling!(o.ctx, {
          from: new Date(now - 86_400_000).toISOString(),
          to: new Date(now).toISOString(),
        });
        exercised.push('compute.billing-export');
        // a bill line may lag by 24-48 h (docs): an empty answer is recorded, not a failure
        return { ok: true, detail: `${rows.length} cost record(s) returned` };
      });
    }
    const failed = steps.some((s) => s.status === 'fail');
    const allLive = evidence.length > 0 && evidence.every((e) => e.kind === 'live');
    if (residual > 0)
      return base('FAIL', 'teardown verifier found residual resources: page the owner (LV-4)', {
        residualResources: residual,
        pageOwner: true,
      });
    if (failed) return base('FAIL', 'one or more steps failed');
    if (!allLive)
      return base(
        'NOT VERIFIED',
        `evidence was not live (${[...new Set(evidence.map((e) => e.kind))].join(', ')}): a run over fixtures or mocks never verifies anything`,
      );
    return base(
      'LIVE-VERIFIED',
      `all steps passed with live evidence under ${o.trigger!.hgId} (${o.trigger!.evidenceId})`,
    );
  }
  function c0() {
    return caps ?? ({} as Record<CapabilityId, never>);
  }
}
