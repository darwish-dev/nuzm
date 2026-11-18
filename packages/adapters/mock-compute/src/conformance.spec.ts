import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeComputeConformance, type ConformanceSubject } from '@nuzm/adapter-conformance';
import { MockComputeAdapter, type FaultKind, type FaultOp } from './mock-compute';

export function mockSubject(): ConformanceSubject {
  const adapter = new MockComputeAdapter();
  return {
    adapter,
    clock: adapter.clock,
    evidenceKind: 'mock',
    ctx: {
      providerAccountId: 'acct-conformance',
      credentialRef: 'vault://dev/mock/conformance',
      traceId: 'trace-conformance',
      deadlineMs: 5000,
    },
    fixture: {
      providerRegionId: 'mock-eu-1',
      planRef: 'mock.small',
      imageRef: 'mock-ubuntu',
      unavailablePlanRef: 'mock.large',
    },
    controls: {
      billableCount: () => adapter.billableCount(),
      billableByToken: (t) => adapter.billableByToken(t),
      advance: (ms) => void adapter.clock.advance(ms),
      inject: (op, kind, times) =>
        void adapter.inject({ op: op as FaultOp, kind: kind as FaultKind, times }),
      setCapabilities: (p) => void adapter.setCapabilities(p),
      setConsistencyLag: (ms) => void adapter.setConsistencyLag(ms),
    },
  };
}

// AC-M05-01: mock-compute passes 100% of the conformance cases. The kit report is written for the evidence folder when asked.
describeComputeConformance({ describe, it, expect }, 'mock-compute', mockSubject, (report) => {
  const dir = process.env.CONFORMANCE_REPORT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'mock-compute-conformance.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
});

// The kit must have teeth: deliberately non-conforming adapters must FAIL the specific cases (otherwise a pass proves nothing).
import { runComputeConformance } from '@nuzm/adapter-conformance';
import type { ComputeAdapter, OperationResult } from '@nuzm/adapter-contracts';

describe('conformance kit rejects non-conforming adapters', () => {
  it('a vendor that duplicates on a replayed token fails C05 (and only through that behaviour)', async () => {
    const report = await runComputeConformance(() => {
      const s = mockSubject();
      (s.adapter as MockComputeAdapter).inject({
        op: 'provision',
        kind: 'duplicate_create',
        times: 100,
      });
      return s;
    });
    expect(report.results.find((r) => r.id === 'C05')?.status).toBe('fail');
  });

  it('an adapter that silently no-ops an unsupported action fails C03 and C09', async () => {
    const report = await runComputeConformance(() => {
      const s = mockSubject();
      const inner = s.adapter as MockComputeAdapter;
      const liar: ComputeAdapter = Object.assign(Object.create(inner) as ComputeAdapter, {
        act: async (): Promise<OperationResult<void>> => ({
          status: 'succeeded',
          raw: { kind: 'mock', capturedAt: inner.clock.iso(), summary: 'silent no-op' },
        }),
      });
      return { ...s, adapter: liar };
    });
    expect(report.results.find((r) => r.id === 'C09')?.status).toBe('fail');
  });

  it('an adapter whose lookup-by-token answers null when unsupported fails C12', async () => {
    const report = await runComputeConformance(() => {
      const s = mockSubject();
      const inner = s.adapter as MockComputeAdapter;
      const liar = Object.assign(Object.create(inner) as ComputeAdapter, {
        findByToken: async (): Promise<OperationResult<null>> => ({
          status: 'succeeded',
          data: null,
          raw: { kind: 'mock', capturedAt: inner.clock.iso(), summary: 'absent?' },
        }),
      });
      return { ...s, adapter: liar };
    });
    expect(report.results.find((r) => r.id === 'C12')?.status).toBe('fail');
  });

  it('an adapter that claims a capability in probe() it cannot perform fails C03', async () => {
    const report = await runComputeConformance(() => {
      const s = mockSubject();
      const inner = s.adapter as MockComputeAdapter;
      inner.setCapabilities({ 'compute.metrics': 'supported' });
      const liar = Object.assign(Object.create(inner) as ComputeAdapter, {
        metrics: async (): Promise<OperationResult<never>> => ({
          status: 'failed',
          error: {
            category: 'unsupported',
            retryable: false,
            providerCode: 'x',
            message: 'no metrics',
          },
          raw: { kind: 'mock', capturedAt: inner.clock.iso(), summary: 'x' },
        }),
      });
      return { ...s, adapter: liar };
    });
    expect(report.results.find((r) => r.id === 'C03')?.status).toBe('fail');
  });
});
