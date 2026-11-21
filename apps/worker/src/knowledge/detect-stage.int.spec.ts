import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nuzm/platform';
import { createEnv, type TestEnv } from '@nuzm/platform/testing';
import { FsObjectStore } from '@nuzm/adapter-knowledge-store';
import { knowledgeArchiveTesting, knowledgeDetectTesting as fx } from '@nuzm/domain';
import { KnowledgeIngestService, type IngestServiceOptions } from './ingest-service';

/**
 * S-K2b: the DETECT stage on a real PostgreSQL under the real `nuzm_worker` role. A clean package goes VALIDATE -> EXTRACT -> DETECT and only then reaches review;
 * a quarantined or rejected one never reaches DETECT; the manifest is append-only evidence; hostile manifests inside a package cannot break the stage.
 */
const { buildZip } = knowledgeArchiveTesting;
let env: TestEnv;
let dir: string;
let store: FsObjectStore;
const UPLOADER = '00000000-0000-7000-8000-0000000000f1';
const MIT =
  'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const zipOf = (tree: Record<string, string>, extra: Record<string, string> = {}) =>
  buildZip(
    Object.entries({ LICENSE: MIT, ...tree, ...extra }).map(([name, data]) => ({
      name,
      data: Buffer.from(data),
    })),
  );

beforeAll(async () => {
  env = await createEnv();
  dir = mkdtempSync(join(tmpdir(), 'nuzm-detect-'));
  store = new FsObjectStore(dir);
});
afterAll(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});
const service = (opts: IngestServiceOptions = {}, s: FsObjectStore = store) =>
  new KnowledgeIngestService(env.worker, s, { heartbeatMs: 50, detect: true, ...opts });

async function submit(bytes: Buffer) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  await store.put(`archives/${sha}`, bytes, { ifAbsent: true });
  const rid = uuidv7();
  const vid = uuidv7();
  await env.sql(
    `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, visibility, source_kind, status, data_region) VALUES ($1,NULL,$2,$2,'THEME','WEB','PLATFORM_PRIVATE','upload','QUARANTINED','sa-central')`,
    [rid, `r-${rid.slice(-8)}`],
  );
  await env.sql(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, created_by) VALUES ($1,$2,NULL,1,'QUARANTINED',$3,$4,$5,$6)`,
    [vid, rid, sha, bytes.length, `archives/${sha}`, UPLOADER],
  );
  await env.sql(`UPDATE knowledge.resources SET current_version_id = $2 WHERE id = $1`, [rid, vid]);
  await env.sql(
    `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
    [uuidv7(), vid],
  );
  return { rid, vid };
}
const state = async (vid: string) =>
  (
    await env.sql(
      `SELECT state, state_reason, ingest_summary FROM knowledge.resource_versions WHERE id = $1`,
      [vid],
    )
  )[0]!;
const jobs = async (vid: string) =>
  (
    await env.sql(
      `SELECT kind, state, attempt FROM knowledge.processing_jobs WHERE version_id = $1 ORDER BY created_at, kind`,
      [vid],
    )
  ).map((j) => `${j.kind}:${j.state}`);
const manifest = async (vid: string) =>
  (
    await env.sql(`SELECT manifest FROM knowledge.resource_manifests WHERE version_id = $1`, [vid])
  )[0]?.manifest as
    Record<string, any> /* eslint-disable-line @typescript-eslint/no-explicit-any */ | undefined;

describe('the DETECT stage', () => {
  it('runs after EXTRACT, writes the manifest and analysis result, and only then moves the version to review', async () => {
    const s = await submit(zipOf(fx.pnpmFullstack()));
    await service().runOnce(); // VALIDATE
    await service().runOnce(); // EXTRACT
    expect(await state(s.vid)).toMatchObject({ state: 'ANALYZING' }); // detection is queued; review has not started
    expect(await jobs(s.vid)).toEqual(['VALIDATE:SUCCEEDED', 'EXTRACT:SUCCEEDED', 'DETECT:QUEUED']);
    expect(
      await env.sql(`SELECT 1 FROM knowledge.resource_manifests WHERE version_id = $1`, [s.vid]),
    ).toHaveLength(0);
    await service().drain();
    expect(await state(s.vid)).toMatchObject({
      state: 'AWAITING_REVIEW',
      ingest_summary: expect.objectContaining({
        detect: expect.objectContaining({
          frameworks: expect.arrayContaining(['nestjs', 'nextjs']),
        }),
      }),
    });
    const m = (await manifest(s.vid))!;
    expect(m).toMatchObject({
      schemaVersion: '1',
      analyzer: { id: 'project-detect' },
      packageManagers: ['pnpm'],
    });
    expect(m.frameworks).toEqual(expect.arrayContaining(['nestjs', 'nextjs', 'react']));
    expect(m.workspaces[0]).toMatchObject({
      tool: 'pnpm',
      members: ['apps/api', 'apps/web', 'packages/ui'],
    });
    expect(m.routes.some((r: { path: string }) => r.path === '/health')).toBe(true);
    expect(m.capabilities.every((c: { evidence: unknown[] }) => c.evidence.length > 0)).toBe(true);
    const ar = (
      await env.sql(
        `SELECT analyzer, analyzer_version, content_hash, confidence::float AS c, result FROM knowledge.analysis_results WHERE version_id = $1`,
        [s.vid],
      )
    )[0]!;
    expect(ar).toMatchObject({ analyzer: 'project-detect', analyzer_version: '1.0.0' });
    expect(String(ar.content_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(ar.c)).toBeGreaterThan(0.5);
    expect(await jobs(s.vid)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
      'DETECT:SUCCEEDED',
    ]);
    // the status of the resource follows the version
    expect(
      (await env.sql(`SELECT status FROM knowledge.resources WHERE id = $1`, [s.rid]))[0]!.status,
    ).toBe('AWAITING_REVIEW');
    const logs = (
      await env.sql(
        `SELECT code FROM knowledge.processing_logs WHERE version_id = $1 ORDER BY seq`,
        [s.vid],
      )
    ).map((l) => l.code);
    expect(logs).toEqual(expect.arrayContaining(['extract.done', 'detect.begin', 'detect.done']));
  });
  it('the manifest is evidence: it cannot be edited or deleted, and a second one for the same schema is not written', async () => {
    const s = await submit(zipOf(fx.reactVite()));
    await service().drain();
    await expect(
      env.sql(
        `UPDATE knowledge.resource_manifests SET manifest = '{}'::jsonb WHERE version_id = $1`,
        [s.vid],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      env.sql(`DELETE FROM knowledge.resource_manifests WHERE version_id = $1`, [s.vid]),
    ).rejects.toThrow(/append-only/);
    expect(
      await env.sql(`SELECT 1 FROM knowledge.resource_manifests WHERE version_id = $1`, [s.vid]),
    ).toHaveLength(1);
  });
  it('a package with a blocking finding is quarantined and never reaches DETECT; nothing is analysed', async () => {
    const key = 'AKIA' + 'QWERTYUIOPASDFGH';
    const s = await submit(zipOf(fx.nextApp(), { 'src/leak.ts': `export const k = "${key}";\n` }));
    await service().drain();
    expect(await state(s.vid)).toMatchObject({
      state: 'QUARANTINED',
      state_reason: 'secrets_found',
    });
    expect(await jobs(s.vid)).toEqual(['VALIDATE:SUCCEEDED', 'EXTRACT:SUCCEEDED']);
    expect(await manifest(s.vid)).toBeUndefined();
  });
  it('a rejected hostile archive never reaches DETECT', async () => {
    const s = await submit(buildZip([{ name: '../evil', data: Buffer.from('x') }]));
    await service().drain();
    expect(await state(s.vid)).toMatchObject({ state: 'FAILED', state_reason: 'path_traversal' });
    expect(await jobs(s.vid).then((j) => j.filter((x) => x.startsWith('DETECT')))).toEqual([]);
  });
  it('with the stage off (the default) the S-K2a flow is unchanged: EXTRACT goes straight to review and no manifest is written', async () => {
    const s = await submit(zipOf(fx.nextApp()));
    await new KnowledgeIngestService(env.worker, store, { heartbeatMs: 50 }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect(await jobs(s.vid)).toEqual(['VALIDATE:SUCCEEDED', 'EXTRACT:SUCCEEDED']);
    expect(await manifest(s.vid)).toBeUndefined();
  });
  it('a worker with the stage off leaves a queued DETECT job alone (the version waits in ANALYZING)', async () => {
    const s = await submit(zipOf(fx.nextApp()));
    await service().runOnce();
    await service().runOnce(); // EXTRACT queues DETECT
    await new KnowledgeIngestService(env.worker, store, { heartbeatMs: 50 }).drain();
    expect(await state(s.vid)).toMatchObject({ state: 'ANALYZING' });
    expect(await jobs(s.vid)).toContain('DETECT:QUEUED');
    await service().drain(); // enabling it later resumes
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
  });
  it('hostile manifests inside a package (prototype pollution, deep JSON, huge fields) are analysed safely', async () => {
    const tree = {
      'package.json':
        '{"name":"x","__proto__":{"polluted":1},"dependencies":{"__proto__":"1","next":"^15"}}',
      'app/page.tsx': 'x',
      'sub/package.json': '{"a":'.repeat(300) + '1' + '}'.repeat(300),
      'other/pubspec.yaml':
        'name: ' + 'a'.repeat(100_000) + '\ndependencies:\n  flutter:\n    sdk: flutter\n',
    };
    const s = await submit(zipOf(tree));
    await service().drain();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await state(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    const m = (await manifest(s.vid))!;
    expect(m.frameworks).toEqual(expect.arrayContaining(['nextjs']));
    expect(JSON.stringify(m).length).toBeLessThan(200_000);
  });
  it('never executes anything: a config file and a lifecycle script that would leave a marker are only read', async () => {
    (globalThis as Record<string, unknown>).__detect_stage_pwned = undefined;
    const s = await submit(
      zipOf(fx.nextApp(), {
        'next.config.mjs': 'globalThis.__detect_stage_pwned = 1; export default {};\n',
        'scripts/run.js': "require('fs').writeFileSync('/tmp/detect-stage-pwned','x')",
      }),
    );
    await service().drain();
    expect((globalThis as Record<string, unknown>).__detect_stage_pwned).toBeUndefined();
    expect((await manifest(s.vid))!.frameworks).toContain('nextjs');
  });
  it('a cancellation while detection runs stops it, writes no manifest and returns the version to quarantine', async () => {
    const s = await submit(zipOf(fx.pnpmFullstack()));
    await service().runOnce();
    await service().runOnce();
    class Slow extends FsObjectStore {
      override async read(k: string) {
        await new Promise((r) => setTimeout(r, 60));
        return super.read(k);
      }
    }
    const running = service({}, new Slow(dir)).runOnce();
    setTimeout(
      () =>
        void env.sql(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE version_id = $1 AND kind = 'DETECT'`,
          [s.vid],
        ),
      150,
    );
    await running;
    expect(await jobs(s.vid)).toContain('DETECT:CANCELLED');
    expect(await state(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await manifest(s.vid)).toBeUndefined();
  });
  it('a detection job that keeps dying is dead-lettered after its last attempt and the version fails with a reason', async () => {
    const s = await submit(zipOf(fx.nextApp()));
    await service().runOnce();
    await service().runOnce(); // DETECT is queued
    // a worker died while running the last attempt: the lease is expired and no attempts are left
    await env.sql(
      `UPDATE knowledge.processing_jobs SET state = 'RUNNING', attempt = 3, lease_owner = 'dead', lease_expires_at = now() - interval '1 minute' WHERE version_id = $1 AND kind = 'DETECT'`,
      [s.vid],
    );
    await service().runOnce();
    expect(await jobs(s.vid)).toContain('DETECT:DEAD_LETTER');
    expect(await state(s.vid)).toMatchObject({
      state: 'FAILED',
      state_reason: 'processing_failed',
    });
    expect(await manifest(s.vid)).toBeUndefined();
  });
});

describe('what the worker role may write', () => {
  it('a manifest only for a version that is being analysed, platform rows only', async () => {
    const s = await submit(zipOf(fx.nextApp()));
    const w = (q: string, p: unknown[] = []) =>
      env.worker.withKnowledgeWorker((c) => c.query(q, p));
    // the version is QUARANTINED: the database refuses the manifest
    await expect(
      w(
        `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,NULL,'1','{}'::jsonb)`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/being analysed/);
    await expect(
      w(
        `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result) VALUES ($1,$2,NULL,'x','1',$3,'{}'::jsonb)`,
        [uuidv7(), s.vid, 'a'.repeat(64)],
      ),
    ).rejects.toThrow(/being analysed/);
    // size bound
    await env.sql(`UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`, [
      s.vid,
    ]);
    await env.sql(`UPDATE knowledge.resource_versions SET state = 'ANALYZING' WHERE id = $1`, [
      s.vid,
    ]);
    // a tenant row is refused by the policy once the version is being analysed
    await expect(
      w(
        `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,$3,'1','{}'::jsonb)`,
        [uuidv7(), s.vid, '00000000-0000-7000-8000-00000000000a'],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      w(
        `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES ($1,$2,NULL,'1',jsonb_build_object('x', repeat('a', 2100000)))`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/resource_manifests_size|check/);
  });
});
