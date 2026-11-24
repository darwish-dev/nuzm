import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { VersionArtifactService } from './internal/artifact.service';
import { loadBuilderConfig } from './internal/model';
import { verifyServedArtifact } from './internal/qa/artifact';
import { assertMinimalEdit } from './internal/qa/edit-diff';
import { buildWebsiteArtifact } from './internal/qa/static-build';
import { PreviewService } from './index';

/**
 * P3-S04 against a real database: the hash-bound artifact of a STORED version (W4 hand-off), the QA gates over stored bytes, the minimal-diff measurement of an edit
 * and restore (W3), and a preview that serves exactly the artifact. SIMULATED model (none is called here); the database, RLS, the isolation hook and the preview service
 * are the real ones.
 */
let e: AiEnv;
const A = () => e.org.A!;
const B = () => e.org.B!;
const j = (r: { json(): unknown }) => r.json() as Row;
const FORMS_ORIGIN = new URL(loadBuilderConfig().formsBaseUrl).origin;

beforeAll(async () => {
  e = await setupAiEnv();
}, 120_000);
afterAll(() => e.h.close());

const mkProject = async (name: string, template = 'services') => {
  const r = await e.call('alice', 'POST', '/v1/builder/projects', {
    type: 'website',
    name,
    locale: ['ar', 'en'],
    templateId: template,
  });
  if (r.statusCode !== 201) throw new Error(`project: ${r.statusCode} ${r.body}`);
  return j(r);
};

describe('hash-bound artifact of a stored version (W4)', () => {
  it('the stored files give a manifest that equals a fresh static build of the same model, and the QA gates pass over the stored bytes', async () => {
    const p = await mkProject('Artifact One');
    const art = e.app.get(VersionArtifactService);
    const { versionId, manifest } = await art.manifest(A(), p.id as string);
    expect(versionId).toBe(p.headVersionId);
    const model = j(await e.call('alice', 'GET', `/v1/builder/projects/${p.id}`))
      .siteModel as never;
    const cfg = loadBuilderConfig();
    const fresh = await buildWebsiteArtifact({
      model,
      formsBaseUrl: `${cfg.formsBaseUrl}/p/${p.id}`,
      qa: false,
    });
    // the commit pipeline and the static build pipeline are the same renderer: same model => same artifact hash
    expect(manifest.rootHash).toBe(fresh.manifest.rootHash);
    expect(manifest.files.length).toBe(fresh.files.length);
    const qa = await art.qa(A(), p.id as string, undefined, {
      axe: 'off',
      formsOrigin: FORMS_ORIGIN,
    });
    expect(qa.report.rootHash).toBe(manifest.rootHash);
    expect(qa.report.gates.filter((g) => g.status === 'fail').map((g) => g.gate)).toEqual([]);
    // the stored bytes still match the manifest
    expect(await art.verify(A(), p.id as string, manifest)).toEqual([]);
  });

  it('another organization cannot read the artifact, the QA or the comparison of a project (RLS + not_found)', async () => {
    const p = await mkProject('Artifact Tenant');
    const art = e.app.get(VersionArtifactService);
    await expect(art.manifest(B(), p.id as string)).rejects.toMatchObject({ code: 'not_found' });
    await expect(art.qa(B(), p.id as string)).rejects.toMatchObject({ code: 'not_found' });
    await expect(art.files(B(), p.id as string)).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      art.compare(B(), p.id as string, p.headVersionId as string, p.headVersionId as string),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(art.manifest(A(), 'not-a-uuid')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a preview serves EXACTLY the artifact: every manifest file fetched through the isolated origin hashes to the manifest', async () => {
    const p = await mkProject('Artifact Preview');
    const art = e.app.get(VersionArtifactService);
    const { manifest } = await art.manifest(A(), p.id as string);
    const r = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/previews`, {
      viewport: 'desktop',
    });
    expect(r.statusCode, r.body).toBe(201);
    const u = new URL(j(r).url as string);
    const tok = u.host.split('.')[0]!;
    const svc = e.app.get(PreviewService);
    const served = await verifyServedArtifact(manifest, async (path) => {
      const s = await svc.serve(u.host, tok, path);
      return s.status === 200 ? Buffer.from(s.body) : undefined;
    });
    expect(served.mismatches).toEqual([]);
    expect(served.servedRootHash).toBe(manifest.rootHash);
  });
});

describe('edit-by-prompt is a minimal diff and restore returns the exact artifact (W3)', () => {
  it('a one-text edit is a new version, measured minimal at model and file level; restore makes a NEW head whose artifact hash equals the original', async () => {
    const p = await mkProject('Edit Minimal');
    const art = e.app.get(VersionArtifactService);
    const v1 = p.headVersionId as string;
    const m1 = await art.manifest(A(), p.id as string, v1);
    const c = await e.call('alice', 'POST', `/v1/builder/projects/${p.id}/changes`, {
      baseVersion: v1,
      source: 'user',
      ops: [{ op: 'setText', target: 'brandName', locale: 'en', value: 'Edited Name' }],
    });
    expect(c.statusCode, c.body).toBe(200);
    const v2 = j(c).newVersion.id as string;
    const m2 = await art.manifest(A(), p.id as string, v2);
    expect(m2.manifest.rootHash).not.toBe(m1.manifest.rootHash);
    const stats = await art.compare(A(), p.id as string, v1, v2);
    expect(stats.verdict).toBe('minimal');
    expect(stats.textsChanged).toBeGreaterThan(0);
    expect(
      stats.sectionsAdded + stats.sectionsRemoved + stats.pagesAdded + stats.pagesRemoved,
    ).toBe(0);
    expect(assertMinimalEdit(stats)).toEqual([]);
    // the brand name shows only in the English pages (+ shared chrome): most output files are untouched
    expect(stats.filesPreserved).toBeGreaterThan(0.3);
    expect(stats.filesAdded + stats.filesRemoved).toBe(0);

    const r = await e.call(
      'alice',
      'POST',
      `/v1/builder/projects/${p.id}/versions/${v1}/restoration`,
    );
    expect(r.statusCode, r.body).toBe(201);
    const v3 = j(r).versionId as string;
    expect(v3).not.toBe(v1); // history is never rewritten
    const m3 = await art.manifest(A(), p.id as string, v3);
    expect(m3.manifest.rootHash).toBe(m1.manifest.rootHash); // ...but the restored artifact is byte-identical to the original
    expect((await art.compare(A(), p.id as string, v1, v3)).verdict).toBe('none');
  });
});
