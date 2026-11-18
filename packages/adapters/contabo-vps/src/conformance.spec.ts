import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runComputeConformance } from '@nuzm/adapter-conformance';
import { makeSubject } from './test-subject';

describe('compute conformance: contabo-vps against the documented-shape simulator (fixture evidence)', () => {
  const stops: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const s of stops) await s();
  });
  it('passes every conformance case (NOT VERIFIED live)', async () => {
    const report = await runComputeConformance(async () => {
      const s = await makeSubject();
      stops.push(s.stop);
      return s;
    });
    const dir = process.env.CONFORMANCE_REPORT_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'contabo-vps-conformance.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
    }
    const failed = report.results.filter((r) => r.status === 'fail');
    expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(report.liveStatus).toBe('NOT VERIFIED');
    expect(report.evidenceKind).toBe('fixture');
  }, 60_000);
});
