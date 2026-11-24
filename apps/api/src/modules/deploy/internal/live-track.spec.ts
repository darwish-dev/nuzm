import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArtifactDirRefused, loadArtifactFromDir } from './artifact-dir';
import { InMemoryArtifactTransport, UnavailableArtifactTransport } from './hosting-target';
import {
  EVIDENCE_SCHEMA,
  parseStagingTargetRecord,
  runLiveTrack,
  validateLiveEvidence,
  type LiveEvidenceRecord,
} from './live-track';
import type { StagingTarget } from './targets';

const real = (over: Partial<StagingTarget> = {}): StagingTarget => ({
  id: 'hosting:staging-1',
  kind: 'static_hosting',
  provider: 'hosting_panel',
  verification: 'NOT VERIFIED',
  region: 'sa-riyadh',
  previewDomain: 'nuzm-staging.example',
  approvalRef: null,
  evidenceRef: null,
  ...over,
});
const REFS = { hg05Ref: 'HG-05:2026-12-01', hg06Ref: 'HG-06:2026-12-01' };
/** a deterministic clock that moves forward one second per call */
const clock = () => {
  let t = Date.parse('2026-12-01T10:00:00Z');
  return () => new Date((t += 1000));
};

describe('track F (preview) and track G (deploy), simulated', () => {
  it('F: stages and smokes the preview, discards it, never switches the live site; everything SIMULATED', async () => {
    const r = await runLiveTrack({ track: 'F', now: clock() });
    expect(r).toMatchObject({ track: 'F', mode: 'simulated', label: 'SIMULATED', status: 'PASS' });
    expect(r.steps.map((s) => s.id)).toEqual([
      'gate',
      'preview',
      'ssl',
      'stage',
      'smoke',
      'discard',
    ]);
    expect(r.url).toMatch(/^https:\/\/staging-[0-9a-f]{16}\.staging\.nuzm\.invalid\/$/);
    expect(r.health?.ok).toBe(true);
    expect(r.rollback).toBeNull();
    expect(r.conclusion).toMatch(/SIMULATED.*NOT VERIFIED on any real node/);
    expect(r.steps.find((s) => s.id === 'discard')?.detail).toMatch(/live hash none/);
  });

  it('G: release 1, release 2, rollback to release 1; ordered timestamps; valid but never live-eligible', async () => {
    const r = await runLiveTrack({ track: 'G', now: clock() });
    expect(r.status).toBe('PASS');
    expect(r.steps.map((s) => s.id)).toEqual([
      'gate',
      'preview',
      'ssl',
      'release1',
      'release2',
      'rollback',
    ]);
    expect(r.rollback).toMatchObject({ performed: true, ok: true, servedHash: r.app.hash });
    expect(r.release).toEqual({ id: 'deploy-r1', previous: 'deploy-r2' });
    expect(r.health?.paths.every((p) => p.status === 200)).toBe(true);
    const c = validateLiveEvidence(r);
    expect(c.valid).toBe(true);
    expect(c.liveEligible).toBe(false);
    expect(c.problems.join(' ')).toMatch(/mode is not real/);
  });

  it('a simulated run refuses a real target', async () => {
    const r = await runLiveTrack({ track: 'G', mode: 'simulated', target: real() });
    expect(r.status).toBe('BLOCKED');
  });
});

describe('real mode refuses without the gates (BLOCKED, nothing deployed)', () => {
  it('needs BOTH approval references, in the right format', async () => {
    const t = new InMemoryArtifactTransport();
    for (const refs of [
      {},
      { hg05Ref: REFS.hg05Ref },
      { hg06Ref: REFS.hg06Ref },
      { hg05Ref: 'HG-06:2026-12-01', hg06Ref: REFS.hg06Ref },
      { hg05Ref: REFS.hg05Ref, hg06Ref: 'yes' },
    ]) {
      const r = await runLiveTrack({
        track: 'G',
        mode: 'real',
        target: real(),
        transport: t,
        ...refs,
      });
      expect(r.status).toBe('BLOCKED');
      expect(r.steps).toHaveLength(1);
    }
    expect(t.puts).toBe(0);
  });

  it('needs a preview domain separate from the console, and an upload path that exists', async () => {
    const t = new InMemoryArtifactTransport();
    expect(
      (
        await runLiveTrack({
          track: 'G',
          mode: 'real',
          target: real({ previewDomain: null }),
          transport: t,
          ...REFS,
        })
      ).status,
    ).toBe('BLOCKED');
    const sh = await runLiveTrack({
      track: 'G',
      mode: 'real',
      target: real({ previewDomain: 'preview.nuzm.sa' }),
      transport: t,
      protectedDomains: ['console.nuzm.sa'],
      ...REFS,
    });
    expect(sh.status).toBe('FAIL');
    expect(sh.steps.at(-1)?.detail).toMatch(/ADR-060/);
    for (const transport of [undefined, new UnavailableArtifactTransport()]) {
      const r = await runLiveTrack({
        track: 'F',
        mode: 'real',
        target: real(),
        ...(transport ? { transport } : {}),
        ...REFS,
      });
      expect(r.status).toBe('BLOCKED');
      expect(r.conclusion).toMatch(/no artifact upload path/);
    }
    expect(t.puts).toBe(0);
  });
});

describe('what may be recorded as LIVE-VERIFIED', () => {
  const standIn = async () =>
    runLiveTrack({
      track: 'G',
      mode: 'real',
      target: real(),
      transport: new InMemoryArtifactTransport(),
      protectedDomains: ['console.nuzm.sa'],
      now: clock(),
      ...REFS,
    });

  it('a run on a stand-in transport is valid but NOT eligible (its SSL result is labelled SIMULATED)', async () => {
    const r = await standIn();
    expect(r.status).toBe('PASS');
    const c = validateLiveEvidence(r);
    expect(c.valid).toBe(true);
    expect(c.liveEligible).toBe(false);
    expect(c.problems.join(' ')).toMatch(/SSL result/);
  });

  it('a complete real record is eligible, and removing any required part makes it ineligible', async () => {
    const base = JSON.parse(JSON.stringify(await standIn())) as LiveEvidenceRecord;
    base.ssl = { state: 'not_required', action: 'none', label: 'NOT VERIFIED' }; // what a real node run records
    for (const st of base.steps) st.detail = st.detail.replace('SIMULATED', 'NOT VERIFIED');
    expect(validateLiveEvidence(base)).toMatchObject({ valid: true, liveEligible: true });
    const mutate = (f: (r: LiveEvidenceRecord) => void) => {
      const r = JSON.parse(JSON.stringify(base)) as LiveEvidenceRecord;
      f(r);
      return validateLiveEvidence(r);
    };
    expect(mutate((r) => (r.mode = 'simulated')).liveEligible).toBe(false);
    expect(mutate((r) => (r.target.hg05Ref = null)).liveEligible).toBe(false);
    expect(mutate((r) => (r.target.hg06Ref = 'HG-06:')).liveEligible).toBe(false);
    expect(mutate((r) => (r.url = 'https://x.staging.nuzm.invalid/')).liveEligible).toBe(false);
    expect(mutate((r) => (r.url = 'http://x.example/')).liveEligible).toBe(false);
    expect(mutate((r) => (r.release.id = null)).liveEligible).toBe(false);
    expect(mutate((r) => (r.health!.paths[0]!.status = 503)).liveEligible).toBe(false);
    expect(mutate((r) => (r.health!.tls = false)).liveEligible).toBe(false);
    expect(mutate((r) => (r.rollback = null)).liveEligible).toBe(false);
    expect(mutate((r) => (r.rollback!.ok = false)).liveEligible).toBe(false);
    expect(mutate((r) => (r.steps[1]!.status = 'FAIL')).liveEligible).toBe(false);
    expect(mutate((r) => (r.conclusion = 'PASS (SIMULATED)')).liveEligible).toBe(false);
    expect(mutate((r) => (r.status = 'FAIL')).liveEligible).toBe(false);
  });

  it('timestamps must be ISO UTC and in order', async () => {
    const base = JSON.parse(JSON.stringify(await standIn())) as LiveEvidenceRecord;
    const a = JSON.parse(JSON.stringify(base)) as LiveEvidenceRecord;
    a.timestamps.finishedAt = '2020-01-01T00:00:00Z';
    expect(validateLiveEvidence(a).valid).toBe(false);
    const b = JSON.parse(JSON.stringify(base)) as LiveEvidenceRecord;
    b.steps[2]!.at = 'yesterday';
    expect(validateLiveEvidence(b).valid).toBe(false);
    const c = JSON.parse(JSON.stringify(base)) as LiveEvidenceRecord;
    c.schema = 'other' as typeof EVIDENCE_SCHEMA;
    expect(validateLiveEvidence(c).valid).toBe(false);
  });
});

describe('staging target record', () => {
  const ok = {
    id: 'hosting:s1',
    kind: 'static_hosting',
    provider: 'hosting_panel',
    verification: 'NOT VERIFIED',
    region: 'sa',
    previewDomain: 'nuzm-staging.example',
    approvalRef: null,
    evidenceRef: null,
  };
  it('parses a valid record', () => {
    const r = parseStagingTargetRecord(JSON.stringify(ok));
    expect(r.ok).toBe(true);
  });
  it('refuses unknown fields (a secret never belongs in the record) without echoing them, bad enums and bad JSON', () => {
    const k = ['api', 'Key'].join('');
    const r = parseStagingTargetRecord(JSON.stringify({ ...ok, [k]: 'super-secret-value' }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
    expect(JSON.stringify(r)).not.toContain(k);
    expect(parseStagingTargetRecord(JSON.stringify({ ...ok, kind: 'x' })).ok).toBe(false);
    expect(parseStagingTargetRecord(JSON.stringify({ ...ok, verification: 'verified' })).ok).toBe(
      false,
    );
    expect(parseStagingTargetRecord('{nope').ok).toBe(false);
    expect(parseStagingTargetRecord('[]').ok).toBe(false);
  });
});

describe('application directory loader', () => {
  const mk = () => mkdtempSync(join(tmpdir(), 'nuzm-app-'));
  it('loads files, hashes deterministically, and runs through the tracks', async () => {
    const d = mk();
    writeFileSync(join(d, 'index.html'), '<h1>hi</h1>');
    mkdirSync(join(d, 'about'));
    writeFileSync(join(d, 'about', 'index.html'), '<p>about</p>');
    const a = loadArtifactFromDir(d);
    expect(a.files.map((f) => f.path)).toEqual(['about/index.html', 'index.html']);
    expect(loadArtifactFromDir(d).hash).toBe(a.hash);
    const r = await runLiveTrack({ track: 'F', artifact: a });
    expect(r.status).toBe('PASS');
    expect(r.app.hash).toBe(a.hash);
  });
  it('refuses symlinks, secrets, VCS data, empty and missing directories', () => {
    const d = mk();
    writeFileSync(join(d, 'index.html'), 'x');
    symlinkSync('/etc/hosts', join(d, 'link.txt'));
    expect(() => loadArtifactFromDir(d)).toThrow(/symbolic link/);
    const e = mk();
    writeFileSync(join(e, 'index.html'), 'x');
    writeFileSync(join(e, '.env'), 'A=1');
    expect(() => loadArtifactFromDir(e)).toThrow(/secrets/);
    expect(() => loadArtifactFromDir(mk())).toThrow(/empty/);
    expect(() => loadArtifactFromDir(join(tmpdir(), 'nuzm-does-not-exist-xyz'))).toThrow(
      ArtifactDirRefused,
    );
  });
});
