import { mkdtemp, readFile, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TEMPLATES, type SiteModel } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import {
  artifactManifest,
  isSafeArtifactPath,
  loadArtifactDir,
  sha256Hex,
  verifyAgainstManifest,
  verifyServedArtifact,
  writeArtifactDir,
  type ArtifactFile,
} from './artifact';
import { assertMinimalEdit, measureEditDiff } from './edit-diff';
import { runWebsiteQa } from './runner';
import { buildWebsiteArtifact } from './static-build';

const enc = new TextEncoder();
const f = (p: string, s: string): ArtifactFile => ({ path: p, bytes: enc.encode(s) });
const FORMS = 'https://api.nuzm.test/p/00000000-0000-7000-8000-000000000001';
const model = (): SiteModel =>
  TEMPLATES[0]!.build({
    name: { ar: 'نموذج', en: 'Sample' },
    locales: ['ar', 'en'],
    baseUrl: 'https://example.test',
  });

describe('hash-bound artifact manifest', () => {
  it('rootHash depends on every path and byte, not on order', () => {
    const a = artifactManifest([f('a.txt', '1'), f('b/c.txt', '2')]);
    const b = artifactManifest([f('b/c.txt', '2'), f('a.txt', '1')]);
    expect(a.rootHash).toBe(b.rootHash);
    expect(artifactManifest([f('a.txt', '1'), f('b/c.txt', '3')]).rootHash).not.toBe(a.rootHash);
    expect(artifactManifest([f('a.txt', '1'), f('b/d.txt', '2')]).rootHash).not.toBe(a.rootHash);
    expect(artifactManifest([f('a.txt', '1')]).rootHash).not.toBe(a.rootHash);
    // provenance is recorded but does not move the binding of the files
    expect(artifactManifest([f('a.txt', '1'), f('b/c.txt', '2')], { x: 'y' }).rootHash).toBe(
      a.rootHash,
    );
  });
  it('refuses unsafe and duplicate paths', () => {
    for (const p of ['../x', '/x', 'a/../b', 'a\\b', '', 'a//b', 'a/./b', 'a\0b'])
      expect(isSafeArtifactPath(p), p).toBe(false);
    expect(() => artifactManifest([f('../x', '1')])).toThrow(/unsafe/);
    expect(() => artifactManifest([f('a', '1'), f('a', '2')])).toThrow(/duplicate/);
  });
  it('detects modified, missing and extra files', () => {
    const files = [f('a', '1'), f('b', '2')];
    const m = artifactManifest(files);
    expect(verifyAgainstManifest(m, files)).toEqual([]);
    const bad = verifyAgainstManifest(m, [f('a', 'X'), f('c', '3')]);
    expect(bad.map((x) => `${x.kind}:${x.path}`).sort()).toEqual([
      'extra:c',
      'missing:b',
      'modified:a',
    ]);
  });
  it('writes and reads a directory back to the same root hash; refuses symlinks', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nuzm-art-'));
    try {
      const files = [f('index.html', '<p>x</p>'), f('assets/a.css', 'p{}')];
      const m = artifactManifest(files);
      const { siteDir, manifestPath } = await writeArtifactDir(dir, files, m);
      expect(artifactManifest(await loadArtifactDir(siteDir)).rootHash).toBe(m.rootHash);
      expect(JSON.parse(await readFile(manifestPath, 'utf8')).rootHash).toBe(m.rootHash);
      await mkdir(path.join(dir, 'evil'));
      await writeFile(path.join(dir, 'evil', 'real.txt'), 'x');
      await symlink('/etc/hosts', path.join(dir, 'evil', 'link'));
      await expect(loadArtifactDir(path.join(dir, 'evil'))).rejects.toThrow(/symbolic links/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('static build pipeline', () => {
  it('is deterministic: the same model yields the same hash-bound artifact, QA included', async () => {
    const a = await buildWebsiteArtifact({
      model: model(),
      formsBaseUrl: FORMS,
      qa: { axe: 'off' },
    });
    const b = await buildWebsiteArtifact({
      model: model(),
      formsBaseUrl: FORMS,
      qa: { axe: 'off' },
    });
    expect(a.ok).toBe(true);
    expect(a.manifest.rootHash).toBe(b.manifest.rootHash);
    expect(a.qa!.rootHash).toBe(a.manifest.rootHash); // the QA report is bound to exactly these files
    expect(a.manifest.provenance.modelHash).toBe(a.modelHash);
    expect(a.manifest.provenance.tailwind).toMatch(/^\d+\.\d+/);
    // no server code and no third-party reference in the output
    expect(
      a.files.some((x) => /\.(php|py|rb|jsx?)$/.test(x.path) && x.path !== 'assets/site.js'),
    ).toBe(false);
  });
  it('a preview build is noindex and a publish build is not; both pass their own QA', async () => {
    const p = await buildWebsiteArtifact({
      model: model(),
      mode: 'preview',
      formsBaseUrl: FORMS,
      qa: { axe: 'off' },
    });
    const q = await buildWebsiteArtifact({
      model: model(),
      mode: 'publish',
      formsBaseUrl: FORMS,
      qa: { axe: 'off' },
    });
    expect(p.ok, JSON.stringify(p.failures)).toBe(true);
    expect(q.ok, JSON.stringify(q.failures)).toBe(true);
    expect(p.manifest.rootHash).not.toBe(q.manifest.rootHash);
  });
  it('an invalid model is refused with findings, not thrown', async () => {
    const m = model();
    m.pages = [];
    const r = await buildWebsiteArtifact({ model: m });
    expect(r.ok).toBe(false);
    expect(r.failures[0]!.code).toBe('model.invalid');
  });
  it('W4: what is served equals what was built, and a changed byte is caught', async () => {
    const r = await buildWebsiteArtifact({ model: model(), formsBaseUrl: FORMS, qa: false });
    const served = new Map(r.files.map((x) => [x.path, x.bytes]));
    const ok = await verifyServedArtifact(r.manifest, async (p) => served.get(p));
    expect(ok.ok).toBe(true);
    expect(ok.servedRootHash).toBe(r.manifest.rootHash);
    // the target serves a tampered stylesheet and drops a page
    const tampered = new Map(served);
    tampered.set('assets/styles.css', enc.encode('body{display:none}'));
    tampered.delete('index.html');
    const bad = await verifyServedArtifact(r.manifest, async (p) => tampered.get(p));
    expect(bad.ok).toBe(false);
    expect(bad.servedRootHash).toBeNull();
    expect(bad.mismatches.map((x) => `${x.kind}:${x.path}`).sort()).toEqual([
      'missing:index.html',
      'modified:assets/styles.css',
    ]);
    // a fetcher that throws counts as missing, never as ok
    const thrown = await verifyServedArtifact(r.manifest, async () => {
      throw new Error('boom');
    });
    expect(thrown.ok).toBe(false);
    expect(sha256Hex('x')).toHaveLength(64);
  });
  it('the gate runner and the build agree on the artifact hash for a directory round trip', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nuzm-art-'));
    try {
      const r = await buildWebsiteArtifact({ model: model(), formsBaseUrl: FORMS, qa: false });
      const { siteDir } = await writeArtifactDir(dir, r.files, r.manifest);
      const qa = await runWebsiteQa(await loadArtifactDir(siteDir), {
        axe: 'off',
        formsOrigin: 'https://api.nuzm.test',
      });
      expect(qa.rootHash).toBe(r.manifest.rootHash);
      expect(qa.passed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('W3: edit-by-prompt is a minimal diff', () => {
  const edit = (m: SiteModel, fn: (x: SiteModel) => void): SiteModel => {
    const c = JSON.parse(JSON.stringify(m)) as SiteModel;
    fn(c);
    return c;
  };
  it("one text change is minimal: one section, only that page's files differ, the rest are byte-identical", async () => {
    const before = model();
    const after = edit(before, (m) => {
      const s = m.pages[0]!.sections.find(
        (x) => typeof (x.props as { heading?: unknown }).heading === 'object',
      )!;
      (s.props as { heading: Record<string, string> }).heading = {
        ar: 'عنوان جديد للصفحة',
        en: 'A new heading',
      };
    });
    const a = await buildWebsiteArtifact({ model: before, qa: false });
    const b = await buildWebsiteArtifact({ model: after, qa: false });
    const s = measureEditDiff(before, after, { before: a.files, after: b.files });
    expect(s.verdict).toBe('minimal');
    expect(s.sectionsChanged + s.textsChanged).toBeGreaterThan(0);
    expect(s.pagesTouched).toBe(1);
    expect(s.filesChanged).toBeLessThanOrEqual(
      2 /* the page in ar and en */ + 1 /* css only if the class set moved */,
    );
    expect(s.filesPreserved).toBeGreaterThan(0.8);
    expect(assertMinimalEdit(s)).toEqual([]);
    expect(a.manifest.rootHash).not.toBe(b.manifest.rootHash);
  });
  it('no change is "none"; a rewrite is refused with words the edit agent can act on', () => {
    const before = model();
    expect(measureEditDiff(before, before).verdict).toBe('none');
    const rewritten = edit(before, (m) => {
      m.pages = m.pages.slice(0, 1);
      m.pages[0]!.sections = m.pages[0]!.sections.slice(0, 1);
      m.brand.colors = {
        primary: '#000000',
        accent: '#111111',
        background: '#ffffff',
        text: '#000000',
      };
    });
    const s = measureEditDiff(before, rewritten);
    expect(s.verdict).toBe('rewrite');
    const problems = assertMinimalEdit(s);
    expect(problems.join(' ')).toMatch(/removed/);
    expect(problems.join(' ')).toMatch(/design tokens/);
  });
});
