import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executionGateway } from '../../index';
import { ExecutionBuildPort } from './index';

/**
 * S04's shared hand-off conformance test (`executionGateway.runLifecycleHandoffConformance`, CONTRACT-04-4) run from S05's side with S05's REAL adapter, over the mock and over the
 * simulated real-runtime node, with `expectSource: true`: the adapter passes `ctx.source`, so H-9 must PASS (never skipped). The only skip allowed is H-8 on the mock rig (the mock
 * has no artifact policy). SIMULATED: this proves wiring and policy, not isolation.
 */
const adapt = (port: never) => new ExecutionBuildPort(port, () => '2026-11-24T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-24T12:00:00.000Z'));
});
afterEach(() => vi.useRealTimers());

const rigs = {
  mock: () => executionGateway.createMockHandoffRig(adapt as never),
  'simulated node': () =>
    executionGateway.createSimulatedNodeHandoffRig(adapt as never, async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    }),
};

describe('lifecycle hand-off conformance with the real ExecutionBuildPort', () => {
  for (const [name, make] of Object.entries(rigs)) {
    it(`${name}: no case fails, H-9 passes, the only skip is H-8 on the mock`, async () => {
      const report = await executionGateway.runLifecycleHandoffConformance(make(), {
        expectSource: true,
      });
      expect(report.fail, JSON.stringify(report.cases.filter((c) => c.status === 'FAIL'))).toBe(0);
      expect(report.cases.find((c) => c.id === 'H-9')!.status).toBe('PASS');
      expect(report.cases.filter((c) => c.status === 'SKIPPED').map((c) => c.id)).toEqual(
        name === 'mock' ? ['H-8'] : [],
      );
      expect(report.statement).toContain('does NOT prove isolation');
    });
  }
});
