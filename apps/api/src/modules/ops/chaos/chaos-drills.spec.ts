import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DRILLS } from './drills';

const root = join(__dirname, '../../../../../..');

describe('chaos drill registry (assertions that the referenced automated tests exist)', () => {
  it('has unique ids and a reason for everything that is not covered', () => {
    expect(new Set(DRILLS.map((d) => d.id)).size).toBe(DRILLS.length);
    for (const d of DRILLS)
      if (d.status !== 'COVERED_BY_INTEGRATION_TEST') expect(d.blockedBy, d.id).toBeTruthy();
  });
  it('every referenced test file exists and still contains the asserting phrase', () => {
    for (const d of DRILLS)
      for (const t of d.tests) {
        const p = join(root, t.file);
        expect(existsSync(p), `${d.id}: ${t.file} missing`).toBe(true);
        expect(
          readFileSync(p, 'utf8').toLowerCase(),
          `${d.id}: "${t.phrase}" not in ${t.file}`,
        ).toContain(t.phrase.toLowerCase());
      }
  });
  it('never claims real-infrastructure verification', () => {
    for (const d of DRILLS) expect(['NOT VERIFIED', 'BLOCKED']).toContain(d.realInfra);
  });
});
