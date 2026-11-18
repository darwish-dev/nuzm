import { describe, expect, it } from 'vitest';
import { DATABASE_CASES, EMAIL_CASES, runConformance } from './conformance';
import { ManualClock, MockDatabaseAdapter, MockTransactionalEmailAdapter } from './mock';
import { databaseSubject, emailSubject, runAllMockConformance } from './test-kit';

describe('conformance suites against the in-memory simulators (AC-M08-01: mock evidence, NOT VERIFIED live)', () => {
  it('every case of every suite passes, and no report claims live verification', async () => {
    const reports = await runAllMockConformance();
    for (const r of reports) {
      const failed = r.results.filter((x) => x.status === 'fail');
      expect(failed, `${r.adapterId}/${r.kind}: ${JSON.stringify(failed)}`).toEqual([]);
      expect(r.liveStatus).toBe('NOT VERIFIED');
      expect(r.evidenceKind).toBe('mock');
      expect(r.total).toBeGreaterThanOrEqual(11);
    }
    expect(reports.map((r) => r.kind).sort()).toEqual([
      'cache',
      'database',
      'database',
      'mailbox',
      'object-storage',
      'transactional-email',
    ]);
  });
});

describe('the suites really detect a broken adapter (negative tests)', () => {
  it('a database adapter that ignores idempotency tokens fails D01/D02', async () => {
    class Broken extends MockDatabaseAdapter {
      override create(
        ctx: Parameters<MockDatabaseAdapter['create']>[0],
        req: Parameters<MockDatabaseAdapter['create']>[1],
      ) {
        return super.create(ctx, { ...req, idempotencyToken: `${Math.random()}` });
      }
    }
    const report = await runConformance(DATABASE_CASES, () => {
      const s = databaseSubject();
      const a = new Broken(new ManualClock());
      return { ...s, adapter: a, controls: a };
    });
    expect(report.results.filter((r) => r.status === 'fail').map((r) => r.id)).toEqual(
      expect.arrayContaining(['D01', 'D02']),
    );
  });
  it('an email adapter that sends twice on replay fails E04', async () => {
    class Broken extends MockTransactionalEmailAdapter {
      override send(
        ctx: Parameters<MockTransactionalEmailAdapter['send']>[0],
        m: Parameters<MockTransactionalEmailAdapter['send']>[1],
        key: string,
      ) {
        return super.send(ctx, m, `${key}-${Math.random()}`);
      }
    }
    const report = await runConformance(EMAIL_CASES, () => {
      const clock = new ManualClock();
      const s = emailSubject();
      const a = new Broken(clock);
      return { ...s, adapter: a, controls: Object.assign(a, { now: () => new Date(clock.now()) }) };
    });
    expect(report.results.find((r) => r.id === 'E04')?.status).toBe('fail');
  });
});
