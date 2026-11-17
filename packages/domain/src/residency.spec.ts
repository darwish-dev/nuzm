import { describe, expect, it } from 'vitest';
import {
  ResidencyDenied,
  RequiresResidency,
  assertResidency,
  type ResidencyEvaluator,
  type ResidencyRequest,
  type ResidencyResult,
} from './residency';

const result = (decision: ResidencyResult['decision']): ResidencyResult => ({
  decision,
  reasons: [{ code: 'x', message: { ar: 'س', en: 'x' } }],
  policyVersion: 1,
  floorVersion: 1,
  assessmentId: null,
  evidenceRef: 'rd_abc',
});
const req: ResidencyRequest = {
  orgId: 'o',
  dataClass: 'personal',
  targetRegion: 'sa-central',
  purpose: 'provisioning',
  operation: 'write',
};
const evaluator = (
  decision: ResidencyResult['decision'],
  seen: ResidencyRequest[] = [],
): ResidencyEvaluator => ({
  evaluate: async (r) => {
    seen.push(r);
    return result(decision);
  },
});

describe('assertResidency', () => {
  it('returns the result when allowed', async () => {
    expect((await assertResidency(evaluator('allow'), req)).decision).toBe('allow');
  });
  it.each(['deny', 'requires_assessment'] as const)(
    'refuses on %s and carries the reasons',
    async (d) => {
      const e = await assertResidency(evaluator(d), req).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ResidencyDenied);
      expect((e as ResidencyDenied).code).toBe('residency_denied');
      expect((e as ResidencyDenied).result.reasons[0]!.message.ar).toBe('س');
    },
  );
});

describe('@RequiresResidency', () => {
  class Provisioner {
    calls = 0;
    constructor(readonly residency?: ResidencyEvaluator) {}
    async provision(orgId: string, region: string) {
      this.calls++;
      return `${orgId}@${region}`;
    }
  }
  // applied by hand: the domain package's test runner does not transform decorator syntax (the API's does)
  const d = Object.getOwnPropertyDescriptor(Provisioner.prototype, 'provision')!;
  RequiresResidency((orgId: string, region: string) => ({ ...req, orgId, targetRegion: region }))(
    Provisioner.prototype,
    'provision',
    d,
  );
  Object.defineProperty(Provisioner.prototype, 'provision', d);
  it('asks BEFORE the method body and passes the resolved request', async () => {
    const seen: ResidencyRequest[] = [];
    const p = new Provisioner(evaluator('allow', seen));
    expect(await p.provision('org-1', 'ae-dubai')).toBe('org-1@ae-dubai');
    expect(seen).toEqual([{ ...req, orgId: 'org-1', targetRegion: 'ae-dubai' }]);
  });
  it('a denied call does nothing: the body never runs', async () => {
    const p = new Provisioner(evaluator('deny'));
    await expect(p.provision('org-1', 'us-east')).rejects.toBeInstanceOf(ResidencyDenied);
    expect(p.calls).toBe(0);
  });
  it('a class without an evaluator fails closed', async () => {
    const p = new Provisioner(undefined);
    await expect(p.provision('o', 'sa-central')).rejects.toThrow(/fail closed/);
    expect(p.calls).toBe(0);
  });
});
