import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registryOf, parseDecisionLog } from './approvals';
import { DETAILS, H, baseRecord, liveRecord, notVerifiedRecord, simulatedRecord } from './fixtures';
import { SchemaSet } from './json-schema';
import { REQUIREMENTS, buildMatrix } from './matrix';
import { SCENARIOS } from '../harness/scenarios';
import {
  TRACKS,
  computeContentHash,
  evidenceDir,
  loadSchemas,
  repoRoot,
  seal,
  sha256Hex,
  verifyAll,
  verifyRecord,
  type Track,
} from './verify';

/**
 * Q1 (P3-S08): the evidence verifier exists, runs in `pnpm verify` (this file is a unit test: no DB, no network) and rejects mislabelled evidence.
 * Every rejection rule has a test that mutates a record that is otherwise valid, so the test proves that exactly that rule fires.
 */
const schemas = loadSchemas();
const ctx = { schemas, dir: null, placement: null } as const;
const check = (r: unknown) => verifyRecord(r, ctx);
const rules = (r: unknown) => [...new Set(check(r).problems.map((p) => p.rule))];
// test helpers edit arbitrary nested fields of a record; the verifier under test is what validates the shape
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
const mutate = (base: Record<string, unknown>, f: (o: Loose) => void) => {
  const o = JSON.parse(JSON.stringify(base)) as Loose;
  f(o);
  return seal(o);
};

describe('schemas: every track has a valid LIVE-VERIFIED and SIMULATED example', () => {
  for (const t of TRACKS) {
    it(`${t}: LIVE-VERIFIED example is accepted`, () => {
      const v = check(liveRecord(t));
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
    });
    it(`${t}: SIMULATED example is accepted`, () => {
      expect(check(simulatedRecord(t)).problems).toEqual([]);
    });
    it(`${t}: NOT VERIFIED example is accepted`, () => {
      expect(check(notVerifiedRecord(t)).problems).toEqual([]);
    });
    it(`${t}: a details object with an unknown field or a missing field is refused`, () => {
      expect(rules(mutate(baseRecord(t, 'LIVE-VERIFIED'), (o) => (o.details.extra = 1)))).toContain(
        'schema',
      );
      const first = Object.keys(DETAILS[t])[0]!;
      expect(
        rules(mutate(baseRecord(t, 'LIVE-VERIFIED'), (o) => delete o.details[first])),
      ).toContain('schema');
    });
  }
  it('there is a schema file for the envelope and for every track', () => {
    expect(schemas.ids().sort()).toEqual(
      ['nuzm.p3-evidence/1', ...TRACKS.map((t) => `nuzm.p3-evidence/track/${t}/1`)].sort(),
    );
  });
});

describe('rejects mislabelled evidence (the mixed-label rule)', () => {
  it('a LIVE-VERIFIED record with a SIMULATED component is rejected', () => {
    const r = mutate(baseRecord('provider', 'LIVE-VERIFIED'), (o) => {
      o.components.push({
        name: 'scripted-gateway',
        version: '1',
        origin: 'simulated',
        label: 'SIMULATED',
      });
    });
    expect(rules(r)).toContain('mixed-labels');
  });
  it('a LIVE-VERIFIED record with one SIMULATED check is rejected', () => {
    const r = mutate(baseRecord('provider', 'LIVE-VERIFIED'), (o) => {
      o.checks.push({ id: 'twin-probe', label: 'SIMULATED', result: 'PASS' });
    });
    expect(rules(r)).toContain('mixed-labels');
  });
  it('a LIVE-VERIFIED record that carries a simulated flag or mock origin anywhere in details is rejected', () => {
    for (const patch of [
      { simulated: true },
      { origin: 'MOCK' },
      { mode: 'twin' },
      { evidenceLabel: 'OFFLINE_MOCK_REPLAY' },
    ]) {
      const r = mutate(baseRecord('benchmark', 'LIVE-VERIFIED'), (o) => {
        o.details.thresholdResults[0].extra = patch;
      });
      // the nested key is also not in the schema; the label rule must fire on its own as well
      expect(rules(r)).toContain('mixed-labels');
    }
  });
  it('a SIMULATED record that claims LIVE-VERIFIED anywhere is rejected (no promotion by copy-paste)', () => {
    const r = mutate(baseRecord('deploy', 'SIMULATED'), (o) => {
      o.checks[0].label = 'LIVE-VERIFIED';
    });
    expect(rules(r)).toContain('mixed-labels');
    const r2 = mutate(baseRecord('deploy', 'SIMULATED'), (o) => {
      o.components[0].label = 'LIVE-VERIFIED';
    });
    expect(rules(r2)).toContain('mixed-labels');
  });
  it('a NOT VERIFIED record may not carry a LIVE-VERIFIED marker', () => {
    const r = mutate(baseRecord('mobile', 'NOT VERIFIED'), (o) => {
      o.checks[0].label = 'LIVE-VERIFIED';
    });
    expect(rules(r)).toContain('mixed-labels');
  });
  it('a record with both a simulated and a live marker is rejected whatever its label says', () => {
    const r = mutate(baseRecord('website', 'SIMULATED'), (o) => {
      o.checks.push({ id: 'a', label: 'LIVE-VERIFIED', result: 'PASS' });
    });
    expect(
      check(r).problems.some(
        (p) => p.rule === 'mixed-labels' && /appear in one record/.test(p.message),
      ),
    ).toBe(true);
  });
  it('a LIVE-VERIFIED record whose component is not real, or whose identity looks like a stand-in, is rejected', () => {
    expect(
      rules(
        mutate(baseRecord('codegen', 'LIVE-VERIFIED'), (o) => (o.components[0].origin = 'offline')),
      ),
    ).toContain('mixed-labels');
    expect(
      rules(
        mutate(
          baseRecord('codegen', 'LIVE-VERIFIED'),
          (o) => (o.identity.model.id = 'mock-model-1'),
        ),
      ),
    ).toContain('live');
    expect(
      rules(
        mutate(
          baseRecord('codegen', 'LIVE-VERIFIED'),
          (o) => (o.identity.model.provider = 'scripted twin'),
        ),
      ),
    ).toContain('live');
    expect(
      rules(
        mutate(
          baseRecord('codegen', 'LIVE-VERIFIED'),
          (o) => (o.components[0].name = 'fake-gateway'),
        ),
      ),
    ).toContain('live');
  });
});

describe('rejects incomplete LIVE-VERIFIED evidence', () => {
  const live = baseRecord('runtime', 'LIVE-VERIFIED');
  it('needs approvals, identity, PASS, passing checks, outputs, a positive duration, and no blockers', () => {
    expect(rules(mutate(live, (o) => (o.approvals = [])))).toContain('live');
    expect(rules(mutate(live, (o) => delete o.identity))).toContain('live');
    expect(rules(mutate(live, (o) => (o.result = 'FAIL')))).toContain('live');
    expect(rules(mutate(live, (o) => (o.checks[0].result = 'FAIL')))).toContain('live');
    expect(rules(mutate(live, (o) => (o.checks = [])))).toContain('live');
    expect(rules(mutate(live, (o) => (o.outputs = [])))).toContain('live');
    expect(rules(mutate(live, (o) => (o.durationMs = 0)))).toContain('live');
    expect(rules(mutate(live, (o) => (o.blockers = [{ id: 'b', text: 'x' }])))).toContain('live');
    expect(rules(mutate(live, (o) => (o.finishedAt = o.startedAt)))).toContain('live');
  });
  it('a cost above the hard maximum is rejected', () => {
    expect(rules(mutate(live, (o) => (o.cost.usedMinor = '500001')))).toContain('live');
    expect(
      rules(mutate(baseRecord('runtime', 'SIMULATED'), (o) => (o.cost.usedMinor = '500001'))),
    ).toContain('cost');
  });
  it('a malformed approval reference is rejected by the schema', () => {
    expect(rules(mutate(live, (o) => (o.approvals[0].ref = '')))).toContain('schema');
  });
  it('a NOT VERIFIED record cannot be PASS, and a failing record must say why', () => {
    expect(
      rules(mutate(baseRecord('mobile', 'NOT VERIFIED'), (o) => (o.result = 'PASS'))),
    ).toContain('label');
    expect(rules(mutate(baseRecord('mobile', 'NOT VERIFIED'), (o) => (o.blockers = [])))).toContain(
      'blockers',
    );
  });
});

describe('hashes', () => {
  it('the content hash is the sha256 of the canonical record without the hash; any edit after sealing is rejected', () => {
    const r = liveRecord('deploy') as Loose;
    expect(r.contentHash).toBe(computeContentHash(r));
    expect(check(r).ok).toBe(true);
    for (const f of [
      (o: Loose) => (o.details.releases[0].contentSha256 = H(99)),
      (o: Loose) => (o.cost.usedMinor = '1'),
      (o: Loose) => (o.result = 'PASS ' as never),
    ]) {
      const edited = JSON.parse(JSON.stringify(r));
      f(edited);
      expect(check(edited).problems.some((p) => p.rule === 'content-hash')).toBe(true);
    }
  });
  it('key order and whitespace do not change the hash', () => {
    const r = liveRecord('codegen') as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(r).reverse());
    expect(computeContentHash(reordered)).toBe(computeContentHash(r));
  });
  it('an output file is hashed and compared; a missing or altered file is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p3s08-ev-'));
    try {
      writeFileSync(join(dir, 'a.bin'), 'hello');
      const good = mutate(baseRecord('codegen', 'LIVE-VERIFIED'), (o) => {
        o.outputs = [{ name: 'a', sha256: sha256Hex('hello'), bytes: 5, path: 'a.bin' }];
      });
      const c = { schemas, dir, placement: null };
      expect(verifyRecord(good, c).problems).toEqual([]);
      writeFileSync(join(dir, 'a.bin'), 'hellx');
      expect(verifyRecord(good, c).problems.some((p) => p.rule === 'file-hash')).toBe(true);
      const missing = mutate(baseRecord('codegen', 'LIVE-VERIFIED'), (o) => {
        o.outputs = [{ name: 'a', sha256: sha256Hex('x'), path: 'nope.bin' }];
      });
      expect(verifyRecord(missing, c).problems.some((p) => p.rule === 'file-hash')).toBe(true);
      const escape = mutate(baseRecord('codegen', 'LIVE-VERIFIED'), (o) => {
        o.outputs = [{ name: 'a', sha256: sha256Hex('x'), path: '../../etc/passwd' }];
      });
      expect(
        verifyRecord(escape, c).problems.some((p) => p.rule === 'file-hash' || p.rule === 'schema'),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('no secrets and no personal data in evidence', () => {
  it('a secret-shaped value, a vault reference or a key block is refused (the value is not echoed)', () => {
    const secret = ['sk-ant-', 'A'.repeat(30)].join('');
    const v = check(
      mutate(baseRecord('provider', 'LIVE-VERIFIED'), (o) => (o.inputs[0].name = secret)),
    );
    expect(v.problems.some((p) => p.rule === 'secret')).toBe(true);
    expect(JSON.stringify(v.problems)).not.toContain(secret);
    expect(
      rules(
        mutate(
          baseRecord('provider', 'LIVE-VERIFIED'),
          (o) => (o.inputs[0].name = ['vault', '://', 'org/key'].join('')),
        ),
      ),
    ).toContain('secret');
  });
  it('an e-mail address is refused unless it is a reserved example address', () => {
    expect(
      rules(
        mutate(
          baseRecord('website', 'LIVE-VERIFIED'),
          (o) => (o.inputs[0].name = 'contact jane@customer-company.sa'),
        ),
      ),
    ).toContain('personal-data');
    expect(
      rules(
        mutate(
          baseRecord('website', 'LIVE-VERIFIED'),
          (o) => (o.inputs[0].name = 'contact jane@example.com'),
        ),
      ),
    ).not.toContain('personal-data');
  });
});

describe('placement and uniqueness (directory verification)', () => {
  const root = mkdtempSync(join(tmpdir(), 'p3s08-root-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  // a throw-away repository layout: pnpm-workspace.yaml + the real schemas
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  mkdirSync(join(root, 'docs/phase3/EVIDENCE'), { recursive: true });
  cpSync(join(evidenceDir(repoRoot()), 'schemas'), join(root, 'docs/phase3/EVIDENCE/schemas'), {
    recursive: true,
  });
  const put = (track: string, file: string, rec: unknown) => {
    mkdirSync(join(root, 'docs/phase3/EVIDENCE', track), { recursive: true });
    writeFileSync(
      join(root, 'docs/phase3/EVIDENCE', track, file),
      typeof rec === 'string' ? rec : JSON.stringify(rec),
    );
  };
  it('accepts a correctly named file and rejects every misplacement; ignores _fixtures and schemas', () => {
    put('codegen', '2026-12-01-codegen-ok.json', liveRecord('codegen', 'codegen-ok'));
    put('codegen', '2026-12-01-wrong-id.json', liveRecord('codegen', 'codegen-other'));
    put('codegen', '2026-12-02-codegen-late.json', liveRecord('codegen', 'codegen-late')); // date differs from recordedAt
    put(
      'preview',
      '2026-12-01-preview-in-wrong-dir.json',
      liveRecord('codegen', 'preview-in-wrong-dir'),
    );
    put('codegen', '2026-12-01-broken.json', '{not json');
    put('_fixtures', 'anything.json', { not: 'evidence' });
    const v = verifyAll(root);
    const byFile = Object.fromEntries(v.results.map((x) => [x.file, x]));
    expect(byFile['codegen/2026-12-01-codegen-ok.json']!.ok).toBe(true);
    expect(byFile['codegen/2026-12-01-wrong-id.json']!.problems.map((p) => p.rule)).toContain(
      'placement',
    );
    expect(byFile['codegen/2026-12-02-codegen-late.json']!.problems.map((p) => p.rule)).toContain(
      'placement',
    );
    expect(
      byFile['preview/2026-12-01-preview-in-wrong-dir.json']!.problems.map((p) => p.rule),
    ).toContain('placement');
    expect(byFile['codegen/2026-12-01-broken.json']!.problems[0]!.message).toBe('not valid JSON');
    expect(
      Object.keys(byFile).some((f) => f.startsWith('_fixtures') || f.startsWith('schemas')),
    ).toBe(false);
    expect(v.accepted.map((r) => r.id)).toEqual(['codegen-ok']);
  });
  it('rejects a second file that reuses an id', () => {
    put('codegen', '2026-12-01-codegen-ok-copy.json', liveRecord('codegen', 'codegen-ok'));
    const v = verifyAll(root);
    expect(v.results.filter((x) => x.problems.some((p) => p.rule === 'duplicate-id')).length).toBe(
      1,
    );
  });
});

describe('the repository evidence directory (this is the CI gate)', () => {
  it('every committed evidence file under docs/phase3/EVIDENCE/<track>/ is accepted by the verifier', () => {
    const v = verifyAll();
    expect(v.rejected.map((r) => ({ file: r.file, problems: r.problems }))).toEqual([]);
  });
});

describe('acceptance matrix', () => {
  const noApprovals = registryOf([]);
  const allApprovals = registryOf(
    [...new Set(REQUIREMENTS.flatMap((r) => r.approvals))].map((id) => ({
      id,
      decision: 'x',
      reference: 'REF-1',
      date: '2026-12-01',
      by: 'owner',
    })),
  );
  const cell = (m: ReturnType<typeof buildMatrix>, id: string) =>
    m.cells.find((c) => c.req.id === id)!;
  it('with no evidence and no approvals every row is BLOCKED with the exact approvals named, and no target is PASS', () => {
    const m = buildMatrix([], noApprovals);
    expect(m.targets.every((t) => t.status === 'BLOCKED')).toBe(true);
    expect(cell(m, 'T3.android').blockers[0]).toContain('B-Android, B-SIGN');
    expect(cell(m, 'T4.ios').blockers.join(' ')).toContain('no macOS host with full Xcode');
  });
  it('with approvals but no evidence a row without any known blocker is NOT VERIFIED, never PASS', () => {
    const m = buildMatrix([], allApprovals);
    expect(cell(m, 'T3.android').status).toBe('NOT VERIFIED');
    expect(cell(m, 'T3.android').blockers).toEqual([]);
  });
  it('a SIMULATED record never makes a row PASS and is shown in its own column', () => {
    const m = buildMatrix([simulatedRecord('mobile') as never], allApprovals);
    expect(cell(m, 'T3.android').status).toBe('NOT VERIFIED');
    expect(cell(m, 'T3.android').simulated).toEqual(['mobile-fixture-1']);
    expect(cell(m, 'T3.android').live).toEqual([]);
  });
  it('a LIVE-VERIFIED PASS record makes exactly its row PASS; the platform condition is respected', () => {
    const m = buildMatrix([liveRecord('mobile') as never], noApprovals);
    expect(cell(m, 'T3.android').status).toBe('PASS');
    expect(cell(m, 'T3.android').blockers).toEqual([]);
    expect(cell(m, 'T4.ios').status).toBe('BLOCKED'); // an android record is not iOS evidence
  });
  it('a target is PASS only when all its rows are PASS; a live FAIL shows FAIL', () => {
    const live = (t: Track, targets: string[], id: string) =>
      ({ ...(liveRecord(t, id) as object), targets }) as never;
    const m = buildMatrix([live('mobile', ['T3'], 'a'), live('codegen', ['T3'], 'b')], noApprovals);
    expect(m.targets.find((t) => t.id === 'T3')!.status).toBe('PASS');
    const failed = {
      ...(liveRecord('mobile', 'f') as object),
      result: 'FAIL',
      targets: ['T3'],
    } as never;
    expect(cell(buildMatrix([failed], noApprovals), 'T3.android').status).toBe('FAIL');
  });
  it('a NOT VERIFIED record contributes its blocker text', () => {
    const m = buildMatrix(
      [{ ...(notVerifiedRecord('mobile') as object), targets: ['T3'] } as never],
      allApprovals,
    );
    expect(cell(m, 'T3.android').status).toBe('BLOCKED');
    expect(cell(m, 'T3.android').blockers[0]).toContain('live validation missing');
  });
  it('rejected files are listed and count for nothing', () => {
    const bad = verifyRecord(
      mutate(baseRecord('mobile', 'LIVE-VERIFIED'), (o) => (o.approvals = [])),
      ctx,
      'mobile/x.json',
    );
    const m = buildMatrix([], noApprovals, [bad]);
    expect(m.rejected).toEqual([{ file: 'mobile/x.json', rules: ['live'] }]);
  });
});

describe('owner approval decision log', () => {
  const doc = (rows: string) =>
    `# x\n## 5. other\n| A | B |\n|---|---|\n| z | y |\n\n## 6. Decision log (a blank reference means undecided)\n| ID | Decision | Reference | Date | By |\n|---|---|---|---|---|\n${rows}\n\n## 7. later\n| ID | Decision | Reference | Date | By |\n|---|---|---|---|---|\n| D9 | x | LATE | d | b |\n`;
  it('the placeholder row and blank references are not approvals', () => {
    expect(parseDecisionLog(doc('| (none recorded) | | | | |'))).toEqual([]);
    expect(parseDecisionLog(doc('| D2 | accept | | 2026-12-01 | owner |'))).toEqual([]);
  });
  it('a row with a reference is an approval; several ids may share a row; only section 6 counts', () => {
    const rows = parseDecisionLog(
      doc(
        '| D2, D5 | accept agreement | AGR-7 | 2026-12-01 | owner |\n| **HG-05** | node | NODE-1 | 2026-12-02 | owner |',
      ),
    );
    expect(rows.map((r) => r.id)).toEqual(['D2', 'D5', 'HG-05']);
    const reg = registryOf(rows);
    expect(reg.has('d2')).toBe(true);
    expect(reg.has('D9')).toBe(false);
    expect(reg.missing(['D2', 'D9'])).toEqual(['D9']);
  });
  it('today the real decision log records nothing, so nothing can be LIVE-VERIFIED yet (this test must be updated when the owner records a decision)', () => {
    const real = parseDecisionLog(
      readFileSync(join(repoRoot(), 'docs/parallel/OWNER-APPROVAL-PACK.md'), 'utf8'),
    );
    expect(Array.isArray(real)).toBe(true);
  });
  it('every approval id the matrix and the harness wait for is an id the approval pack tells the owner to record', () => {
    const pack = readFileSync(join(repoRoot(), 'docs/parallel/OWNER-APPROVAL-PACK.md'), 'utf8');
    // The id is the bold lead of a row's first cell ("| **ADR-069** (…) | …"). Parenthesised former names are not ids.
    const asked = new Set([...pack.matchAll(/^\|\s*\*\*([A-Za-z0-9.-]+)\*\*/gm)].map((m) => m[1]));
    const waitedFor = [...REQUIREMENTS, ...SCENARIOS].flatMap((r) => r.approvals);
    expect([...new Set(waitedFor)].filter((id) => !asked.has(id))).toEqual([]);
  });
  it('the Execution Gateway is ADR-069: an approval recorded for ADR-067 (the HestiaCP panel) does not unblock it', () => {
    const row = (id: string) => ({ id, decision: 'accept', reference: 'R-1', date: 'd', by: 'b' });
    const runtime = REQUIREMENTS.find((r) => r.id === 'T2.runtime')!;
    expect(registryOf([row('ADR-067')]).missing(runtime.approvals)).toContain('ADR-069');
    expect(registryOf([row('ADR-069')]).missing(runtime.approvals)).not.toContain('ADR-069');
  });
});

describe('the schema validator itself', () => {
  const s = new SchemaSet([
    {
      $id: 't',
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
  ]);
  it('reports type, range, missing and extra properties', () => {
    expect(s.validate('t', { a: 1 })).toEqual([]);
    expect(s.validate('t', { a: 0 }).length).toBe(1);
    expect(s.validate('t', { a: 1.5 }).length).toBe(1);
    expect(s.validate('t', {}).length).toBe(1);
    expect(s.validate('t', { a: 1, b: 2 }).length).toBe(1);
  });
  it('refuses to guess: an unsupported keyword throws instead of passing', () => {
    expect(() => new SchemaSet([{ $id: 'u', format: 'email' }]).validate('u', 'x')).toThrow(
      /not supported/,
    );
  });
});
