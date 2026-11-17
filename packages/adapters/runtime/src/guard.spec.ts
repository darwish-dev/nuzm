import { describe, expect, it } from 'vitest';
import { AdapterTimeoutError, Redactor, type ComputeAdapter } from '@nuzm/adapter-contracts';
import { GuardedCompute, SimClock } from './index';

const ctx = {
  providerAccountId: 'a1',
  credentialRef: 'vault://t/a',
  traceId: 't',
  deadlineMs: 1000,
};
const stub = (over: Partial<ComputeAdapter>): ComputeAdapter =>
  ({ id: 's', kind: 'compute', contractVersion: '1.0.0', ...over }) as ComputeAdapter;

describe('GuardedCompute', () => {
  it('turns a thrown timeout during a MUTATING call into `uncertain`, and during a read into a retryable failure', async () => {
    const g = new GuardedCompute({ clock: new SimClock(), redactor: new Redactor() });
    const a = g.wrap(
      stub({
        provision: async () => {
          throw new AdapterTimeoutError();
        },
        inspect: async () => {
          throw new AdapterTimeoutError();
        },
      }),
    );
    const p = await a.provision(ctx, { idempotencyToken: 't' } as never);
    const i = await a.inspect(ctx, 'r');
    expect(p.status).toBe('uncertain');
    expect(i.status).toBe('failed');
    expect(i.error?.retryable).toBe(true);
  });
  it('an open breaker refuses the call without sending it (definitive failure)', async () => {
    let sent = 0;
    const clock = new SimClock();
    const g = new GuardedCompute({
      clock,
      redactor: new Redactor(),
      breaker: { failureThreshold: 2, cooldownMs: 5000 },
    });
    const a = g.wrap(
      stub({
        provision: async () => {
          sent++;
          throw new AdapterTimeoutError();
        },
      }),
    );
    await a.provision(ctx, {} as never);
    await a.provision(ctx, {} as never);
    const r = await a.provision(ctx, {} as never);
    expect(sent).toBe(2);
    expect(r.status).toBe('failed');
    expect(r.error?.providerCode).toBe('circuit_open');
    expect(g.breakerSnapshot('a1').state).toBe('open');
    clock.advance(5000);
    await a.provision(ctx, {} as never);
    expect(sent).toBe(3);
  });
  it('rate limit: calls beyond the burst are refused locally and not sent', async () => {
    let sent = 0;
    const g = new GuardedCompute({
      clock: new SimClock(),
      redactor: new Redactor(),
      rate: { burst: 2, perSecond: 1 },
    });
    const a = g.wrap(
      stub({
        inspect: async () => (
          sent++,
          { status: 'succeeded', raw: { kind: 'mock', capturedAt: 'x', summary: 's' } }
        ),
      }),
    );
    const rs = [await a.inspect(ctx, 'r'), await a.inspect(ctx, 'r'), await a.inspect(ctx, 'r')];
    expect(rs.map((r) => r.status)).toEqual(['succeeded', 'succeeded', 'failed']);
    expect(rs[2]!.error?.category).toBe('rate_limit');
    expect(sent).toBe(2);
  });
  it('scrubs secrets out of evidence and error messages', async () => {
    const red = new Redactor().register('CANARY-IN-ERROR-123');
    const a = new GuardedCompute({ clock: new SimClock(), redactor: red }).wrap(
      stub({
        delete: async () => ({
          status: 'failed',
          error: {
            category: 'unknown',
            retryable: false,
            providerCode: 'x',
            message: 'bad key CANARY-IN-ERROR-123',
          },
          raw: { kind: 'mock', capturedAt: 'x', summary: 'CANARY-IN-ERROR-123' },
        }),
      }),
    );
    const r = await a.delete(ctx, 'r');
    expect(red.leaks(r)).toBe(false);
  });
});
