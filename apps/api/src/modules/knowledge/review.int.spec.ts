import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';
import { FsObjectStore } from '@nuzm/adapter-knowledge-store';
import { MockModelAdapter } from '@nuzm/adapter-model';
import { RunService } from '../ai';
import { ProjectsPort } from '../appbuilder';

/**
 * S-K2a (SCR-K-02) over HTTP on the real schema: the ingestion job queue as an operator sees it, the findings and inventory, and the review gate in front of
 * activation (two different approvers for third-party resources, the uploader excluded, licence, findings, rejection). The pipeline itself (worker) is proved
 * in apps/worker; here the worker's results are written directly so that the API contract is tested on its own.
 */
let e: AiEnv;
const R = '/v1/admin/knowledge';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const admin = (
  who: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: object | Buffer,
  h?: Record<string, string>,
) => e.admin(who, method, url, body, h);
const ok = <T = Row>(
  r: { statusCode: number; body: string; json: () => unknown },
  status = 200,
): T => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json() as T;
};

beforeAll(async () => {
  process.env.KNOWLEDGE_STORE_DIR = mkdtempSync(join(tmpdir(), 'nuzm-knowledge-review-'));
  e = await setupAiEnv();
  for (const [name, roles] of [
    ['psec', ['security']],
    ['psupport2', ['support']],
  ] as const) {
    const s = await e.h.platformUser(e.app, name, [...roles]);
    e.jars[name] = s.jar;
    e.ids[name] = s.id;
  }
  await e.sql(
    `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
  );
}, 180_000);
afterAll(() => e.h.close());

/** Uploads a tiny package as `who` and returns {resourceId, versionId}. */
async function submit(
  who = 'padmin',
  meta: Row = {},
  name = `Theme ${randomUUID().slice(0, 6)}`,
  resourceId?: string,
) {
  const data = Buffer.from(`not-a-real-zip-${randomUUID()}`);
  const open = ok(
    await admin(who, 'POST', `${R}/uploads`, {
      name,
      resourceType: 'THEME',
      declaredBytes: data.length,
      sha256: sha(data),
      filename: 'theme.zip',
      ...(resourceId ? { resourceId } : {}),
    }),
    201,
  );
  ok(
    await admin(who, 'PUT', `${R}/uploads/${open.id}/parts/1`, data, {
      'x-part-sha256': sha(data),
    }),
  );
  const done = ok(
    await admin(who, 'POST', `${R}/uploads/${open.id}/completion`, {
      parts: [{ partNumber: 1, sha256: sha(data) }],
      ...(resourceId ? { resourceId } : {}),
      metadata: {
        name,
        resourceType: 'THEME',
        platform: 'WEB',
        frameworks: ['nextjs'],
        license: 'MIT',
        ...meta,
      },
    }),
    202,
  );
  const v = (
    await e.sql(
      `SELECT id FROM knowledge.resource_versions WHERE resource_id = $1 ORDER BY seq DESC LIMIT 1`,
      [done.id],
    )
  )[0]!;
  return { resourceId: done.id as string, versionId: v.id as string };
}

/** What the worker leaves behind for a package that passed ingestion (written directly, the worker has its own tests). */
async function analysed(
  s: { resourceId: string; versionId: string },
  o: { proposal?: string; block?: number; warn?: number; noFiles?: boolean } = {},
) {
  const v = s.versionId;
  const jid = randomUUID();
  await e.sql(
    `UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE version_id = $1 AND kind = 'VALIDATE' AND state = 'QUEUED'`,
    [v],
  );
  await e.sql(
    `UPDATE knowledge.processing_jobs SET state = 'SUCCEEDED', finished_at = now() WHERE version_id = $1 AND kind = 'VALIDATE'`,
    [v],
  );
  await e.sql(`UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`, [v]);
  await e.sql(`UPDATE knowledge.resource_versions SET state = 'ANALYZING' WHERE id = $1`, [v]);
  await e.sql(
    `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'EXTRACT')`,
    [jid, v],
  );
  await e.sql(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE id = $1`, [jid]);
  await e.sql(
    `UPDATE knowledge.processing_jobs SET state = 'SUCCEEDED', finished_at = now() WHERE id = $1`,
    [jid],
  );
  await e.sql(
    `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES (gen_random_uuid(),$1,$2,NULL,'info','EXTRACT','extract.done','analysis finished')`,
    [jid, v],
  );
  for (let i = 0; i < (o.block ?? 0); i++)
    await e.sql(
      `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, path, line, detail) VALUES (gen_random_uuid(),$1,NULL,$2,'secrets','secret_found','block','src/c.ts',$3,'aws_access_key at src/c.ts')`,
      [v, jid, i + 1],
    );
  for (let i = 0; i < (o.warn ?? 0); i++)
    await e.sql(
      `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, path, line, detail) VALUES (gen_random_uuid(),$1,NULL,$2,'dependencies','lifecycle_script','warn','package.json',NULL,'"postinstall" runs at install time; it was NOT run')`,
      [v, jid],
    );
  if (!o.noFiles)
    await e.sql(
      `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes, language, object_key) VALUES (gen_random_uuid(),$1,NULL,'src/app.ts',$2,10,'typescript','snapshots/x'),(gen_random_uuid(),$1,NULL,'.env',$2,4,NULL,NULL)`,
      [v, 'e'.repeat(64)],
    );
  await e.sql(
    `UPDATE knowledge.resource_versions SET analysis_job_id = $2, license_proposal = $3::jsonb, ingest_summary = '{"files":2}'::jsonb WHERE id = $1`,
    [
      v,
      jid,
      JSON.stringify({
        spdx: 'MIT',
        verdict: o.proposal ?? 'ALLOWED',
        conflicts: false,
        evidence: [],
      }),
    ],
  );
  await e.sql(
    `UPDATE knowledge.resource_versions SET state = ${o.block ? "'QUARANTINED'" : "'AWAITING_REVIEW'"} WHERE id = $1`,
    [v],
  );
  await e.sql(
    `UPDATE knowledge.resources SET status = ${o.block ? "'QUARANTINED'" : "'AWAITING_REVIEW'"} WHERE id = $1`,
    [s.resourceId],
  );
  return jid;
}
const review = (
  who: string,
  s: { resourceId: string; versionId: string },
  decision: 'approve' | 'reject',
  extra: Row = {},
) =>
  admin(who, 'POST', `${R}/resources/${s.resourceId}/reviews`, {
    versionId: s.versionId,
    decision,
    ...(decision === 'approve'
      ? { checklist: { findingsReviewed: true, licenseReviewed: true } }
      : { note: 'The licence file is not the one the seller supplied.' }),
    ...extra,
  });
const activate = (who: string, s: { resourceId: string; versionId: string }) =>
  admin(who, 'POST', `${R}/resources/${s.resourceId}/activation`, { versionId: s.versionId });
const reviewState = async (who: string, s: { resourceId: string; versionId: string }) =>
  ok<Row>(await admin(who, 'GET', `${R}/resources/${s.resourceId}/versions/${s.versionId}/review`));

describe('upload completion enqueues validation', () => {
  it('creates a THIRD_PARTY resource, a QUARANTINED version and one VALIDATE job', async () => {
    const s = await submit();
    const res = (
      await e.sql(`SELECT provenance_class, status FROM knowledge.resources WHERE id = $1`, [
        s.resourceId,
      ])
    )[0]!;
    expect(res).toMatchObject({ provenance_class: 'THIRD_PARTY', status: 'QUARANTINED' });
    const jobs = ok<{ items: Row[] }>(
      await admin('padmin', 'GET', `${R}/resources/${s.resourceId}/processing-jobs`),
    );
    expect(jobs.items).toHaveLength(1);
    expect(jobs.items[0]).toMatchObject({
      kind: 'VALIDATE',
      state: 'QUEUED',
      versionId: s.versionId,
      attempt: 0,
      maxAttempts: 3,
      cancelRequested: false,
    });
  });
  it('FIRST_PARTY is a publish-level declaration and only the two documented values exist', async () => {
    const f = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
    expect(
      (
        await e.sql(`SELECT provenance_class FROM knowledge.resources WHERE id = $1`, [
          f.resourceId,
        ])
      )[0]!.provenance_class,
    ).toBe('FIRST_PARTY');
    const data = Buffer.from('x-' + randomUUID());
    const open = ok(
      await admin('padmin', 'POST', `${R}/uploads`, {
        name: 'bad',
        resourceType: 'THEME',
        declaredBytes: data.length,
        sha256: sha(data),
        filename: 'a.zip',
      }),
      201,
    );
    ok(
      await admin('padmin', 'PUT', `${R}/uploads/${open.id}/parts/1`, data, {
        'x-part-sha256': sha(data),
      }),
    );
    const bad = await admin('padmin', 'POST', `${R}/uploads/${open.id}/completion`, {
      parts: [{ partNumber: 1, sha256: sha(data) }],
      metadata: { name: 'bad', resourceType: 'THEME', provenanceClass: 'SELF_ATTESTED' },
    });
    expect(bad.statusCode).toBe(422);
  });
});

describe('processing jobs, logs and cancellation', () => {
  it('lists jobs per resource and per version, and reads a job log', async () => {
    const s = await submit();
    const jid = await analysed(s);
    const all = ok<{ items: Row[] }>(
      await admin(
        'psupport2',
        'GET',
        `${R}/resources/${s.resourceId}/processing-jobs?versionId=${s.versionId}`,
      ),
    );
    expect(all.items.map((j) => `${j.kind}:${j.state}`).sort()).toEqual([
      'EXTRACT:SUCCEEDED',
      'VALIDATE:SUCCEEDED',
    ]);
    const logs = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('psupport2', 'GET', `${R}/resources/${s.resourceId}/processing-jobs/${jid}/logs`),
    );
    expect(logs.items[0]).toMatchObject({ level: 'info', stage: 'EXTRACT', code: 'extract.done' });
    expect(logs.nextCursor).toBeNull();
    expect(
      (
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${s.resourceId}/processing-jobs/${randomUUID()}/logs`,
        )
      ).statusCode,
    ).toBe(404);
  });
  it('a job of another resource is not reachable through this resource', async () => {
    const a = await submit();
    const b = await submit();
    const jb = (
      await e.sql(`SELECT id FROM knowledge.processing_jobs WHERE version_id = $1`, [b.versionId])
    )[0]!.id as string;
    expect(
      (await admin('padmin', 'GET', `${R}/resources/${a.resourceId}/processing-jobs/${jb}/logs`))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${a.resourceId}/processing-jobs/${jb}/cancellation`,
          {},
        )
      ).statusCode,
    ).toBe(404);
  });
  it('cancels a queued job, returns the version to QUARANTINED with a reason, and allows a retry', async () => {
    const s = await submit();
    const jid = (
      await e.sql(`SELECT id FROM knowledge.processing_jobs WHERE version_id = $1`, [s.versionId])
    )[0]!.id as string;
    expect(
      (
        await admin(
          'psupport2',
          'POST',
          `${R}/resources/${s.resourceId}/processing-jobs/${jid}/cancellation`,
          {},
        )
      ).statusCode,
    ).toBe(403);
    expect(
      ok(
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${s.resourceId}/processing-jobs/${jid}/cancellation`,
          {},
        ),
      ),
    ).toMatchObject({ jobId: jid, result: 'CANCELLED' });
    expect(
      (
        await e.sql(`SELECT state, state_reason FROM knowledge.resource_versions WHERE id = $1`, [
          s.versionId,
        ])
      )[0],
    ).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${s.resourceId}/processing-jobs/${jid}/cancellation`,
          {},
        )
      ).statusCode,
    ).toBe(409);
    const re = ok<Row>(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
        {},
      ),
    );
    expect(re.versionId).toBe(s.versionId);
    expect(
      (
        await e.sql(`SELECT kind, state FROM knowledge.processing_jobs WHERE id = $1`, [re.jobId])
      )[0],
    ).toMatchObject({ kind: 'VALIDATE', state: 'QUEUED' });
    // a second retry while one is waiting is refused
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
          {},
        )
      ).statusCode,
    ).toBe(409);
  });
  it('a running job is asked to stop (the worker acts on the flag)', async () => {
    const s = await submit();
    const jid = (
      await e.sql(`SELECT id FROM knowledge.processing_jobs WHERE version_id = $1`, [s.versionId])
    )[0]!.id as string;
    await e.sql(
      `UPDATE knowledge.processing_jobs SET state = 'RUNNING', attempt = 1, lease_owner = 'w', lease_expires_at = now() + interval '1 minute' WHERE id = $1`,
      [jid],
    );
    expect(
      ok(
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${s.resourceId}/processing-jobs/${jid}/cancellation`,
          {},
        ),
      ),
    ).toMatchObject({ result: 'CANCEL_REQUESTED' });
    expect(
      (
        await e.sql(`SELECT state, cancel_requested FROM knowledge.processing_jobs WHERE id = $1`, [
          jid,
        ])
      )[0],
    ).toMatchObject({ state: 'RUNNING', cancel_requested: true });
  });
  it('only an interrupted version can be retried; a rejected or analysed one cannot', async () => {
    const s = await submit();
    await analysed(s);
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
          {},
        )
      ).statusCode,
    ).toBe(409);
    const hostile = await submit();
    await e.sql(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE version_id = $1`, [
      hostile.versionId,
    ]);
    await e.sql(`UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`, [
      hostile.versionId,
    ]);
    await e.sql(
      `UPDATE knowledge.processing_jobs SET state = 'FAILED', error_code = 'ratio_exceeded' WHERE version_id = $1`,
      [hostile.versionId],
    );
    await e.sql(
      `UPDATE knowledge.resource_versions SET state = 'FAILED', state_reason = 'ratio_exceeded' WHERE id = $1`,
      [hostile.versionId],
    );
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${hostile.resourceId}/versions/${hostile.versionId}/reprocessing`,
          {},
        )
      ).statusCode,
    ).toBe(409);
    const flaky = await submit();
    await e.sql(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE version_id = $1`, [
      flaky.versionId,
    ]);
    await e.sql(`UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`, [
      flaky.versionId,
    ]);
    await e.sql(
      `UPDATE knowledge.processing_jobs SET state = 'DEAD_LETTER' WHERE version_id = $1`,
      [flaky.versionId],
    );
    await e.sql(
      `UPDATE knowledge.resource_versions SET state = 'FAILED', state_reason = 'processing_failed' WHERE id = $1`,
      [flaky.versionId],
    );
    ok(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${flaky.resourceId}/versions/${flaky.versionId}/reprocessing`,
        {},
      ),
    );
    expect(
      (
        await e.sql(`SELECT state FROM knowledge.resource_versions WHERE id = $1`, [
          flaky.versionId,
        ])
      )[0]!.state,
    ).toBe('QUARANTINED');
  });
});

describe('retiring a resource stops its processing', () => {
  it('archiving cancels queued jobs; disabling asks a running job to stop', async () => {
    const a = await submit();
    const b = await submit();
    await e.sql(
      `UPDATE knowledge.processing_jobs SET state = 'RUNNING', attempt = 1, lease_owner = 'w', lease_expires_at = now() + interval '1 minute' WHERE version_id = $1`,
      [b.versionId],
    );
    ok(
      await admin('padmin', 'POST', `${R}/resources/${a.resourceId}/archival`, {
        reason: 'obsolete package',
      }),
    );
    ok(
      await admin('padmin', 'POST', `${R}/resources/${b.resourceId}/deactivation`, {
        reason: 'licence under review',
      }),
    );
    expect(
      (
        await e.sql(
          `SELECT state, error_code FROM knowledge.processing_jobs WHERE version_id = $1`,
          [a.versionId],
        )
      )[0],
    ).toMatchObject({ state: 'CANCELLED', error_code: 'cancelled' });
    expect(
      (
        await e.sql(
          `SELECT state, cancel_requested FROM knowledge.processing_jobs WHERE version_id = $1`,
          [b.versionId],
        )
      )[0],
    ).toMatchObject({ state: 'RUNNING', cancel_requested: true });
  });
});

describe('findings and inventory', () => {
  it('lists findings with counts and filters; evidence is a kind and path:line, never content', async () => {
    const s = await submit();
    await analysed(s, { warn: 2, block: 0 });
    const f = ok<{ items: Row[]; summary: Row }>(
      await admin(
        'psupport2',
        'GET',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/findings`,
      ),
    );
    expect(f.summary).toMatchObject({ info: 0, warn: 2, block: 0 });
    expect(f.items[0]).toMatchObject({
      scanner: 'dependencies',
      code: 'lifecycle_script',
      severity: 'warn',
      path: 'package.json',
    });
    expect(
      ok<{ items: Row[] }>(
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/findings?severity=block`,
        ),
      ).items,
    ).toEqual([]);
    expect(
      (
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/findings?severity=nope`,
        )
      ).statusCode,
    ).toBe(422);
    const page = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin(
        'padmin',
        'GET',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/findings?limit=1`,
      ),
    );
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTruthy();
  });
  it('lists the inventory (never content) with a path search and a stored filter', async () => {
    const s = await submit();
    await analysed(s);
    const all = ok<{ items: Row[] }>(
      await admin('padmin', 'GET', `${R}/resources/${s.resourceId}/versions/${s.versionId}/files`),
    );
    expect(all.items.map((x) => x.path).sort()).toEqual(['.env', 'src/app.ts']);
    expect(JSON.stringify(all)).not.toMatch(/object_?key|snapshots\//i);
    expect(
      ok<{ items: Row[] }>(
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/files?stored=false`,
        ),
      ).items.map((x) => x.path),
    ).toEqual(['.env']);
    expect(
      ok<{ items: Row[] }>(
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/files?q=app`,
        ),
      ).items,
    ).toHaveLength(1);
  });
  it('is flag-gated like the rest of the library', async () => {
    await e.sql(
      `DELETE FROM platform.feature_flags WHERE key = 'knowledge.library' AND org_id IS NULL`,
    );
    const id = randomUUID();
    for (const u of [
      `${R}/resources/${id}/processing-jobs`,
      `${R}/resources/${id}/versions/${id}/review`,
      `${R}/resources/${id}/versions/${id}/findings`,
    ])
      expect((await admin('padmin', 'GET', u)).statusCode).toBe(404);
    expect(
      (await admin('padmin', 'POST', `${R}/resources/${id}/activation`, { versionId: id }))
        .statusCode,
    ).toBe(404);
    await e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'knowledge.library', NULL, 'true'::jsonb)`,
    );
  });
});

/** The state a version is left in when its detection job dies after a completed extraction: FAILED, with an analysis and no manifest. */
async function detectionDied(versionId: string) {
  for (const st of ['QUARANTINED', 'VALIDATING', 'ANALYZING'])
    await e.sql(`UPDATE knowledge.resource_versions SET state = '${st}' WHERE id = $1`, [
      versionId,
    ]);
  await e.sql(
    `UPDATE knowledge.resource_versions SET state = 'FAILED', state_reason = 'processing_failed' WHERE id = $1`,
    [versionId],
  );
}

describe('the project manifest (S-K2b)', () => {
  it('is null until detection has run, then returns the stored manifest to read-only staff; other resources and the flag are respected', async () => {
    const s = await submit();
    const none = ok<Row>(
      await admin(
        'psupport2',
        'GET',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/manifest`,
      ),
    );
    expect(none).toMatchObject({ versionId: s.versionId, manifest: null, schemaVersion: null });
    await analysed(s);
    const m = {
      schemaVersion: '1',
      analyzer: { id: 'project-detect', version: '1.0.0' },
      frameworks: ['nextjs'],
      capabilities: [
        {
          name: 'styling-system',
          confidence: 0.85,
          evidence: [{ kind: 'dependency', path: 'package.json' }],
        },
      ],
    };
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1',$2::jsonb)`,
      [s.versionId, JSON.stringify(m)],
    );
    const got = ok<Row>(
      await admin(
        'psupport2',
        'GET',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/manifest`,
      ),
    );
    expect(got).toMatchObject({ schemaVersion: '1', manifest: m });
    // the resource summary reads the same manifest (frameworks, capabilities with evidence)
    const detail = ok<Row>(await admin('psupport2', 'GET', `${R}/resources/${s.resourceId}`));
    expect(detail.manifest).toMatchObject({
      frameworks: ['nextjs'],
      capabilities: [{ name: 'styling-system', evidence: [{ path: 'package.json' }] }],
    });
    const other = await submit();
    expect(
      (
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${other.resourceId}/versions/${s.versionId}/manifest`,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await e.call(
          'alice',
          'GET',
          `${R}/resources/${s.resourceId}/versions/${s.versionId}/manifest`,
        )
      ).statusCode,
    ).not.toBe(200);
  });
  it('re-queues detection (not validation) for an analysed version whose detection failed, and refuses once a manifest exists', async () => {
    const s = await submit();
    await analysed(s);
    // detection died: the version is FAILED after its analysis, with no manifest
    await detectionDied(s.versionId);
    const r = ok<Row>(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
        {},
      ),
    );
    expect(
      (
        await e.sql(`SELECT kind, state FROM knowledge.processing_jobs WHERE id = $1`, [r.jobId])
      )[0],
    ).toMatchObject({ kind: 'DETECT', state: 'QUEUED' });
    expect(
      (
        await e.sql(`SELECT state FROM knowledge.resource_versions WHERE id = $1`, [s.versionId])
      )[0]!.state,
    ).toBe('QUARANTINED');
    const t = await submit();
    await analysed(t);
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1','{}'::jsonb),(gen_random_uuid(),$1,NULL,'2','{}'::jsonb),(gen_random_uuid(),$1,NULL,'3','{}'::jsonb)`,
      [t.versionId],
    );
    await detectionDied(t.versionId);
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${t.resourceId}/versions/${t.versionId}/reprocessing`,
          {},
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe('design DNA, tokens and variants (S-K4)', () => {
  const tokenRows: [string, string, string | null, string | null, string, string, boolean][] = [
    ['color', '--primary', '221 83% 53%', null, 'base', 'css-var', false],
    ['color', '--primary', '217 91% 60%', null, 'dark', 'css-var', false],
    [
      'color',
      'colors.brand',
      'hsl(var(--primary))',
      'hsl(221 83% 53%)',
      'base',
      'tailwind-config',
      false,
    ],
    ['color', 'colors.plugin', null, null, 'base', 'tailwind-config', true],
    ['typography', '--font-sans', 'Cairo, sans-serif', null, 'base', 'tailwind-theme', false],
    ['radius', '--radius', '0.5rem', null, 'base', 'css-var', false],
  ];
  it('serves the design document, tokens (filters, paging) and variants; read-only staff may read; customers may not', async () => {
    const s = await submit();
    await analysed(s);
    const base = `${R}/resources/${s.resourceId}/versions/${s.versionId}`;
    // not analysed yet: an explicit null, not an error
    expect(ok<Row>(await admin('padmin', 'GET', `${base}/design`))).toMatchObject({
      versionId: s.versionId,
      design: null,
      createdAt: null,
    });
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${base}/theme-tokens`)).items,
    ).toEqual([]);
    for (const [i, [cat, name, value, resolved, mode, origin, dynamic]] of tokenRows.entries())
      await e.sql(
        `INSERT INTO knowledge.theme_tokens (id, version_id, org_id, category, name, value, resolved_value, source_path, mode, line, origin, dynamic) VALUES (gen_random_uuid(),$1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          s.versionId,
          cat,
          name,
          value,
          resolved,
          `src/f${i % 2}.css`,
          mode,
          i + 1,
          origin,
          dynamic,
        ],
      );
    for (const [kind, name] of [
      ['color-scheme', 'dark'],
      ['layout', 'RootLayout'],
      ['sidebar', 'Sidebar'],
    ])
      await e.sql(
        `INSERT INTO knowledge.theme_variants (id, version_id, org_id, kind, name, descriptor) VALUES (gen_random_uuid(),$1,NULL,$2,$3,'{"path":"src/x.tsx"}'::jsonb)`,
        [s.versionId, kind, name],
      );
    await e.sql(
      `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result) VALUES (gen_random_uuid(),$1,NULL,'design-dna','1.0.0',$2,$3::jsonb)`,
      [
        s.versionId,
        'a'.repeat(64),
        JSON.stringify({
          schemaVersion: '1',
          primary: 0,
          projects: [{ root: '.', modes: ['base', 'dark'] }],
        }),
      ],
    );

    const d = ok<Row>(await admin('psupport2', 'GET', `${base}/design`));
    expect(d.design).toMatchObject({
      schemaVersion: '1',
      projects: [{ root: '.', modes: ['base', 'dark'] }],
    });
    expect(typeof d.createdAt).toBe('string');

    const all = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('psupport2', 'GET', `${base}/theme-tokens`),
    );
    expect(all.items).toHaveLength(6);
    expect(all.items.find((x) => x.name === 'colors.plugin')).toMatchObject({
      value: null,
      resolvedValue: null,
      dynamic: true,
    });
    expect(all.items.find((x) => x.name === 'colors.brand')).toMatchObject({
      value: 'hsl(var(--primary))',
      resolvedValue: 'hsl(221 83% 53%)',
      origin: 'tailwind-config',
      mode: 'base',
    });
    const names = async (qs: string) =>
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${base}/theme-tokens?${qs}`))
        .items.map((x) => `${x.mode}:${x.name}`)
        .sort();
    expect(await names('category=radius')).toEqual(['base:--radius']);
    expect(await names('mode=dark')).toEqual(['dark:--primary']);
    expect(await names('origin=tailwind-theme')).toEqual(['base:--font-sans']);
    expect(await names('dynamic=true')).toEqual(['base:colors.plugin']);
    expect(await names('dynamic=false&category=color')).toHaveLength(3);
    expect(await names('q=BRAND')).toEqual(['base:colors.brand']);
    expect(await names('q=%25')).toEqual([]); // LIKE metacharacters are literal
    for (const bad of ['category=nope', 'origin=nope', 'dynamic=maybe'])
      expect((await admin('padmin', 'GET', `${base}/theme-tokens?${bad}`)).statusCode).toBe(422);
    const page = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('padmin', 'GET', `${base}/theme-tokens?limit=4`),
    );
    expect(page.items).toHaveLength(4);
    const rest = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('padmin', 'GET', `${base}/theme-tokens?limit=4&cursor=${page.nextCursor}`),
    );
    expect(rest.items).toHaveLength(2);
    expect(rest.nextCursor).toBeNull();

    const v = ok<{ items: Row[] }>(await admin('psupport2', 'GET', `${base}/theme-variants`));
    expect(v.items.map((x) => `${x.kind}:${x.name}`).sort()).toEqual([
      'color-scheme:dark',
      'layout:RootLayout',
      'sidebar:Sidebar',
    ]);
    expect(v.items[0]).toMatchObject({ descriptor: { path: 'src/x.tsx' }, hasPreview: false });
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${base}/theme-variants?kind=sidebar`))
        .items,
    ).toHaveLength(1);

    // a version of another resource is not reachable through this one; customers never reach any of it
    const other = await submit();
    for (const path of ['design', 'theme-tokens', 'theme-variants'])
      expect(
        (
          await admin(
            'padmin',
            'GET',
            `${R}/resources/${other.resourceId}/versions/${s.versionId}/${path}`,
          )
        ).statusCode,
      ).toBe(404);
    for (const path of ['design', 'theme-tokens', 'theme-variants'])
      expect((await e.call('alice', 'GET', `${base}/${path}`)).statusCode).not.toBe(200);
  });

  it('re-queues the design analysis for a version that has schema 2 but not 3', async () => {
    const s = await submit();
    await analysed(s);
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1','{}'::jsonb),(gen_random_uuid(),$1,NULL,'2','{}'::jsonb)`,
      [s.versionId],
    );
    await detectionDied(s.versionId);
    const r = ok<Row>(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
        {},
      ),
    );
    expect(
      (await e.sql(`SELECT kind FROM knowledge.processing_jobs WHERE id = $1`, [r.jobId]))[0]!.kind,
    ).toBe('DESIGN');
  });
});

describe('components and relationships (S-K2c)', () => {
  it('lists the registry with filters and paging, and the relationships with evidence; read-only staff may read; nothing is reusable', async () => {
    const s = await submit();
    await analysed(s);
    const rows: [string, string, string, string][] = [
      ['Button', 'react-component', 'react', 'src/components/button.tsx'],
      ['Home', 'next-page', 'next', 'src/app/page.tsx'],
      ['UsersService', 'nest-provider', 'nestjs', 'src/users.service.ts'],
      ['Card', 'react-component', 'react', 'src/components/card.tsx'],
    ];
    for (const [name, kind, fw, path] of rows)
      await e.sql(
        `INSERT INTO knowledge.resource_components (id, version_id, org_id, name, kind, framework, path, props, dependencies, platforms) VALUES (gen_random_uuid(),$1,NULL,$2,$3,$4,$5,$6::jsonb,'{react}','{web}')`,
        [
          s.versionId,
          name,
          kind,
          fw,
          path,
          JSON.stringify([{ name: 'label', type: 'string', required: true }]),
        ],
      );
    await e.sql(
      `INSERT INTO knowledge.resource_relationships (id, version_id, org_id, from_kind, from_ref, to_kind, to_ref, relation, evidence) VALUES (gen_random_uuid(),$1,NULL,'component','src/app/page.tsx#Home','component','src/components/button.tsx#Button','renders','{"path":"src/app/page.tsx","line":3}'::jsonb),(gen_random_uuid(),$1,NULL,'file','src/app/page.tsx','file','src/components/button.tsx','imports','{"path":"src/app/page.tsx","line":1}'::jsonb)`,
      [s.versionId],
    );
    const base = `${R}/resources/${s.resourceId}/versions/${s.versionId}`;
    const all = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('psupport2', 'GET', `${base}/components`),
    );
    expect(all.items.map((x) => x.name).sort()).toEqual(['Button', 'Card', 'Home', 'UsersService']);
    expect(all.items.every((x) => x.reuseAllowed === false)).toBe(true);
    expect(all.items[0]).toMatchObject({
      props: [{ name: 'label', type: 'string', required: true }],
      dependencies: ['react'],
      platforms: ['web'],
    });
    expect(
      ok<{ items: Row[] }>(
        await admin('padmin', 'GET', `${base}/components?kind=next-page`),
      ).items.map((x) => x.name),
    ).toEqual(['Home']);
    expect(
      ok<{ items: Row[] }>(
        await admin('padmin', 'GET', `${base}/components?framework=nestjs`),
      ).items.map((x) => x.name),
    ).toEqual(['UsersService']);
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${base}/components?q=card`)).items.map(
        (x) => x.name,
      ),
    ).toEqual(['Card']);
    expect((await admin('padmin', 'GET', `${base}/components?kind=nope`)).statusCode).toBe(422);
    const page = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('padmin', 'GET', `${base}/components?limit=3`),
    );
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeTruthy();
    const rest = ok<{ items: Row[]; nextCursor: string | null }>(
      await admin('padmin', 'GET', `${base}/components?limit=3&cursor=${page.nextCursor}`),
    );
    expect(rest.items).toHaveLength(1);
    const rel = ok<{ items: Row[] }>(await admin('psupport2', 'GET', `${base}/relationships`));
    expect(rel.items.map((x) => x.relation).sort()).toEqual(['imports', 'renders']);
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${base}/relationships?relation=renders`))
        .items[0],
    ).toMatchObject({
      fromRef: 'src/app/page.tsx#Home',
      toRef: 'src/components/button.tsx#Button',
      evidence: { path: 'src/app/page.tsx', line: 3 },
    });
    expect(
      ok<{ items: Row[] }>(
        await admin(
          'padmin',
          'GET',
          `${base}/relationships?ref=${encodeURIComponent('src/components/button.tsx#Button')}`,
        ),
      ).items,
    ).toHaveLength(1);
    expect((await admin('padmin', 'GET', `${base}/relationships?relation=nope`)).statusCode).toBe(
      422,
    );
    const other = await submit();
    expect(
      (
        await admin(
          'padmin',
          'GET',
          `${R}/resources/${other.resourceId}/versions/${s.versionId}/components`,
        )
      ).statusCode,
    ).toBe(404);
    expect((await e.call('alice', 'GET', `${base}/components`)).statusCode).not.toBe(200);
  });
  it('re-queues the component analysis (not detection) for a version that has only the schema-1 manifest', async () => {
    const s = await submit();
    await analysed(s);
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1','{}'::jsonb)`,
      [s.versionId],
    );
    await detectionDied(s.versionId);
    const r = ok<Row>(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
        {},
      ),
    );
    expect(
      (await e.sql(`SELECT kind FROM knowledge.processing_jobs WHERE id = $1`, [r.jobId]))[0]!.kind,
    ).toBe('COMPONENTS');
    // with the schema-2 manifest present the version is complete: no retry
    const t = await submit();
    await analysed(t);
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1','{}'::jsonb),(gen_random_uuid(),$1,NULL,'2','{}'::jsonb),(gen_random_uuid(),$1,NULL,'3','{}'::jsonb)`,
      [t.versionId],
    );
    await detectionDied(t.versionId);
    expect(
      (
        await admin(
          'padmin',
          'POST',
          `${R}/resources/${t.resourceId}/versions/${t.versionId}/reprocessing`,
          {},
        )
      ).statusCode,
    ).toBe(409);
  });
});

describe('the review gate', () => {
  it('third-party: two different approvers, the uploader excluded; the database agrees', async () => {
    const s = await submit('padmin');
    await analysed(s, { warn: 1 });
    let st = await reviewState('psupport2', s);
    expect(st).toMatchObject({
      state: 'AWAITING_REVIEW',
      provenanceClass: 'THIRD_PARTY',
      requiredApprovals: 2,
      canActivate: false,
    });
    expect((st.blockers as Row[]).map((b) => b.code)).toEqual(['approvals_missing']);
    // read-only staff cannot review or activate
    expect((await review('psupport2', s, 'approve')).statusCode).toBe(403);
    expect((await activate('psupport2', s)).statusCode).toBe(403);
    // the uploader cannot review their own third-party upload
    const self = await review('padmin', s, 'approve');
    expect(self.statusCode).toBe(403);
    expect(await reviewState('padmin', s)).toMatchObject({
      you: { canReview: false, isUploader: true },
    });
    // approvals need the confirmations
    expect(
      (
        await admin('padmin2', 'POST', `${R}/resources/${s.resourceId}/reviews`, {
          versionId: s.versionId,
          decision: 'approve',
        })
      ).statusCode,
    ).toBe(422);
    // one approval is not enough
    st = ok<Row>(await review('padmin2', s, 'approve'), 201);
    expect(st).toMatchObject({
      approvals: [e.ids.padmin2],
      canActivate: false,
      you: { hasApproved: true, canReview: false },
    });
    const early = await activate('padmin', s);
    expect(early.statusCode).toBe(409);
    expect(early.json().code).toBe('knowledge_approval_required');
    // the same person twice does not count twice
    expect((await review('padmin2', s, 'approve')).statusCode).toBe(409);
    // the second, different approver completes the gate
    st = ok<Row>(await review('psec', s, 'approve'), 201);
    expect(st).toMatchObject({ canActivate: true, blockers: [] });
    const act = ok<Row>(await activate('padmin', s));
    expect(act).toMatchObject({ state: 'ACTIVE', licenseVerdict: 'ALLOWED' });
    expect(
      (await e.sql(`SELECT status FROM knowledge.resources WHERE id = $1`, [s.resourceId]))[0]!
        .status,
    ).toBe('ACTIVE');
    expect(
      (
        await e.sql(
          `SELECT license_verdict, license_spdx FROM knowledge.resource_permissions WHERE resource_id = $1`,
          [s.resourceId],
        )
      )[0],
    ).toMatchObject({ license_verdict: 'ALLOWED', license_spdx: 'MIT' });
    // activation does not publish: visibility is a separate, explicit decision
    expect(
      (await e.sql(`SELECT visibility FROM knowledge.resources WHERE id = $1`, [s.resourceId]))[0]!
        .visibility,
    ).toBe('PLATFORM_PRIVATE');
    expect((await activate('padmin', s)).statusCode).toBe(409);
  });
  it('first-party needs one approval and the uploader may give it', async () => {
    const s = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
    await analysed(s);
    expect(await reviewState('padmin', s)).toMatchObject({
      requiredApprovals: 1,
      you: { canReview: true },
    });
    ok<Row>(await review('padmin', s, 'approve'), 201);
    expect(ok<Row>(await activate('padmin', s))).toMatchObject({ state: 'ACTIVE' });
  });
  it('a licence that is not ALLOWED can be reviewed but never activated (verdict is not user-settable)', async () => {
    for (const proposal of ['UNKNOWN', 'RESTRICTED', 'BLOCKED']) {
      const s = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
      await analysed(s, { proposal });
      ok<Row>(await review('padmin2', s, 'approve'), 201);
      const st = await reviewState('padmin', s);
      expect((st.blockers as Row[]).map((b) => b.code)).toContain('license_not_allowed');
      const r = await activate('padmin', s);
      expect(r.statusCode, proposal).toBe(409);
      expect(r.json().code).toBe('knowledge_license_blocked');
      expect(
        (
          await e.sql(
            `SELECT state, license_verdict FROM knowledge.resource_versions WHERE id = $1`,
            [s.versionId],
          )
        )[0],
      ).toMatchObject({ state: 'AWAITING_REVIEW', license_verdict: 'UNKNOWN' });
    }
  });
  it('a package with a blocking finding stays quarantined: it cannot be reviewed or activated', async () => {
    const s = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
    await analysed(s, { block: 1 });
    const st = await reviewState('padmin', s);
    expect(st).toMatchObject({ state: 'QUARANTINED', canActivate: false, findings: { block: 1 } });
    expect((st.blockers as Row[]).map((b) => b.code)).toEqual(
      expect.arrayContaining(['state', 'blocking_findings']),
    );
    expect((await review('padmin2', s, 'approve')).statusCode).toBe(409);
    const r = await activate('padmin', s);
    expect(r.statusCode).toBe(409);
    expect(
      (
        await e.sql(`SELECT state FROM knowledge.resource_versions WHERE id = $1`, [s.versionId])
      )[0]!.state,
    ).toBe('QUARANTINED');
  });
  it('a rejection needs a reason, returns the version to QUARANTINED and is final for that analysis', async () => {
    const s = await submit('padmin');
    await analysed(s);
    expect(
      (
        await admin('padmin2', 'POST', `${R}/resources/${s.resourceId}/reviews`, {
          versionId: s.versionId,
          decision: 'reject',
          note: 'no',
        })
      ).statusCode,
    ).toBe(422);
    const st = ok<Row>(await review('padmin2', s, 'reject'), 201);
    expect(st).toMatchObject({ state: 'QUARANTINED', stateReason: 'rejected', canActivate: false });
    expect(
      (await e.sql(`SELECT status FROM knowledge.resources WHERE id = $1`, [s.resourceId]))[0]!
        .status,
    ).toBe('QUARANTINED');
    expect((await review('psec', s, 'approve')).statusCode).toBe(409);
    expect((await activate('padmin', s)).statusCode).toBe(409);
  });
  it('activating a new version retires the previous one to DISABLED (never overwritten) and the old one can return only through the gate', async () => {
    const one = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
    await analysed(one);
    ok(await review('padmin2', one, 'approve'), 201);
    ok(await activate('padmin', one));
    const two = await submit('padmin', {}, 'ignored', one.resourceId);
    expect(two.resourceId).toBe(one.resourceId);
    await analysed(two);
    // the resource is first-party, so one approval suffices
    ok(await review('padmin2', two, 'approve'), 201);
    ok(await activate('padmin', two));
    const rows = await e.sql(
      `SELECT seq, state FROM knowledge.resource_versions WHERE resource_id = $1 ORDER BY seq`,
      [one.resourceId],
    );
    expect(rows).toEqual([
      { seq: 1, state: 'DISABLED' },
      { seq: 2, state: 'ACTIVE' },
    ]);
    expect(
      (
        await e.sql(
          `SELECT count(*)::int n FROM knowledge.resource_versions WHERE resource_id = $1 AND state = 'ACTIVE'`,
          [one.resourceId],
        )
      )[0]!.n,
    ).toBe(1);
  });
  it('a version of another resource cannot be reviewed through this one', async () => {
    const a = await submit('padmin');
    const b = await submit('padmin');
    await analysed(b);
    const r = await admin('padmin2', 'POST', `${R}/resources/${a.resourceId}/reviews`, {
      versionId: b.versionId,
      decision: 'approve',
      checklist: { findingsReviewed: true, licenseReviewed: true },
    });
    expect(r.statusCode).toBe(404);
  });
  it('every decision is audited with who, what and why', async () => {
    const s = await submit('padmin', { provenanceClass: 'FIRST_PARTY' });
    await analysed(s);
    ok(await review('padmin2', s, 'approve'), 201);
    ok(await activate('padmin', s));
    const rows = e.sink.events.filter(
      (x) => String(x.action).startsWith('knowledge.version.') && x.resource?.id === s.resourceId,
    );
    expect(rows.map((r) => r.action)).toEqual([
      'knowledge.version.approved',
      'knowledge.version.activated',
    ]);
    expect(rows[0]).toMatchObject({ actorUserId: e.ids.padmin2, outcome: 'success' });
    expect(rows[1]).toMatchObject({ actorUserId: e.ids.padmin, outcome: 'success' });
    expect(rows[1]!.detail).toMatchObject({ versionId: s.versionId, approvers: [e.ids.padmin2] });
    expect(JSON.stringify(rows)).not.toMatch(/AKIA|PRIVATE KEY/);
  });
});

/** Seeds for the retrieval and customer-template suites. */
interface Item {
  name: string;
  platform?: string;
  frameworks?: string[];
  scope?: 'NONE' | 'ARCHITECTURE_ONLY' | 'COMPONENTS' | 'FULL_STARTER';
  starter?: boolean;
  components?: boolean;
  architecture?: boolean;
  ai?: boolean;
  published?: boolean;
  license?: 'ALLOWED' | 'RESTRICTED';
  quality?: number;
  dna?: Row;
  docs?: [string, string, string, string][];
  description?: string;
  /** Stored text files of the version: written to the object store and inventoried, so a customer copy can read them. `bytes` overrides the recorded size (to model an oversized file). */
  files?: {
    path: string;
    content: string;
    bytes?: number;
    binary?: boolean;
    stored?: boolean;
    /** the row points at an object that is not in the store */
    missing?: boolean;
    /** the recorded digest is not the digest of the stored bytes */
    tampered?: boolean;
  }[];
  capabilities?: string[];
}
/** An ACTIVE library resource (through the real gate) with permissions, documents, a manifest, a Design DNA and quality evidence written directly. */
async function item(o: Item) {
  const s = await submit(
    'padmin',
    {
      provenanceClass: 'FIRST_PARTY',
      platform: o.platform ?? 'WEB',
      frameworks: o.frameworks ?? ['nextjs'],
      ...(o.description ? { description: o.description } : {}),
    },
    o.name,
  );
  await analysed(s, { noFiles: true });
  ok<Row>(await review('padmin', s, 'approve'), 201);
  ok<Row>(await activate('padmin', s));
  const v = s.versionId;
  for (const f of o.files ?? []) {
    const buf = Buffer.from(f.content);
    const key = `snapshots/${v}/${sha(buf).slice(0, 16)}`;
    if (f.stored !== false && f.missing !== true)
      await new FsObjectStore(process.env.KNOWLEDGE_STORE_DIR!).put(key, buf, { ifAbsent: true });
    await e.sql(
      `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes, language, is_binary, object_key) VALUES (gen_random_uuid(),$1,NULL,$2,$3,$4,$5,$6,$7)`,
      [
        v,
        f.path,
        f.tampered ? 'f'.repeat(64) : sha(buf),
        f.bytes ?? buf.length,
        f.path.endsWith('.json') ? 'json' : f.path.endsWith('.md') ? 'markdown' : 'typescript',
        f.binary === true,
        f.stored === false || f.binary === true ? null : key,
      ],
    );
  }
  await e.sql(`UPDATE knowledge.resources SET visibility = $2 WHERE id = $1`, [
    s.resourceId,
    o.published === false ? 'PLATFORM_PRIVATE' : 'PLATFORM_PUBLISHED',
  ]);
  await e.sql(
    `UPDATE knowledge.resource_permissions SET reuse_scope = $2, starter_eligible = $3, component_reuse = $4, architecture_reference = $5, ai_processing = $6, license_verdict = $7 WHERE resource_id = $1`,
    [
      s.resourceId,
      o.scope ?? 'FULL_STARTER',
      o.starter ?? (o.scope ?? 'FULL_STARTER') === 'FULL_STARTER',
      ['COMPONENTS', 'FULL_STARTER'].includes(o.scope ?? 'FULL_STARTER'),
      true,
      o.ai ?? true,
      o.license ?? 'ALLOWED',
    ],
  );
  await e.sql(
    `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1',$2::jsonb)`,
    [
      v,
      JSON.stringify({
        frameworks: o.frameworks ?? ['nextjs'],
        capabilities: (o.capabilities ?? []).map((name) => ({
          name,
          evidence: [{ path: 'src/secret/x.ts', line: 1 }],
        })),
      }),
    ],
  );
  if (o.architecture !== false) {
    await e.sql(
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'2',$2::jsonb)`,
      [
        v,
        JSON.stringify({
          frameworks: o.frameworks ?? ['nextjs'],
          capabilities: (o.capabilities ?? []).map((name) => ({
            name,
            evidence: [{ path: 'src/secret/x.ts', line: 1 }],
          })), // a later manifest is a full one
          architecture: {
            layers: [{}, {}],
            cycles: [],
            entryReachability: { roots: 1, analysedFiles: 10, unreachable: 0 },
          },
        }),
      ],
    );
    await e.sql(
      `INSERT INTO knowledge.resource_components (id, version_id, org_id, name, kind, path) VALUES (gen_random_uuid(),$1,NULL,'Card','react-component','src/card.tsx')`,
      [v],
    );
  }
  for (const [kind, ref, title, body] of o.docs ?? [])
    await e.sql(
      `INSERT INTO knowledge.resource_search_documents (id, version_id, org_id, doc_kind, ref, title, body, content_hash) VALUES (gen_random_uuid(),$1,NULL,$2,$3,$4,$5,$6)`,
      [v, kind, ref, title, body, 'c'.repeat(64)],
    );
  if (o.dna)
    await e.sql(
      `INSERT INTO knowledge.analysis_results (id, version_id, org_id, analyzer, analyzer_version, content_hash, result) VALUES (gen_random_uuid(),$1,NULL,'design-dna','1.0.0',$2,$3::jsonb)`,
      [v, 'd'.repeat(64), JSON.stringify(o.dna)],
    );
  if (o.quality !== undefined)
    await e.sql(
      `INSERT INTO knowledge.quality_scores (id, version_id, org_id, dimension, score, method, evidence_ref, measured) VALUES (gen_random_uuid(),$1,NULL,'BUILD',$2,'build-log','job:1',true)`,
      [v, o.quality],
    );
  return s;
}
const dna = (darkMode: boolean, rtl: boolean, primary: string): Row => ({
  schemaVersion: '1',
  primary: 0,
  projects: [
    {
      traits: { darkMode, rtl, arabicFont: false, tailwind: true },
      palette: [{ mode: 'base', roles: [{ role: 'primary', hex: primary }] }],
    },
  ],
});

describe('retrieval and recommendation (S-K5)', () => {
  let dash: { resourceId: string; versionId: string };
  let store: { resourceId: string; versionId: string };
  let draft: { resourceId: string; versionId: string };
  const rec = (body: Row, who = 'psupport2') => admin(who, 'POST', `${R}/recommendations`, body);
  const names = (xs: Row[]) => xs.map((x) => x.name as string);

  beforeAll(async () => {
    dash = await item({
      name: 'Admin Dashboard Pro',
      description: 'Analytics dashboard with charts',
      quality: 90,
      dna: dna(true, true, '#2563eb'),
      docs: [
        [
          'SUMMARY',
          'summary',
          'Admin Dashboard Pro',
          'frameworks: nextjs tailwind capabilities: analytics dashboard charts tables',
        ],
        [
          'COMPONENT',
          'src/data-table.tsx#DataTable',
          'DataTable',
          'DataTable data table sorting columns',
        ],
        ['DESIGN', 'design', 'design', 'design dark mode rtl tailwind colours: primary #2563eb'],
      ],
    });
    store = await item({
      name: 'Store Starter',
      docs: [
        [
          'SUMMARY',
          'summary',
          'Store Starter',
          'frameworks: nextjs capabilities: store checkout cart products payments',
        ],
        ['FEATURE', 'route:/checkout', 'route /checkout', 'page route checkout cart'],
      ],
    });
    await item({
      name: 'Gym Mobile',
      platform: 'MOBILE',
      frameworks: ['flutter'],
      scope: 'COMPONENTS',
      ai: false,
      docs: [
        [
          'SUMMARY',
          'summary',
          'Gym Mobile',
          'frameworks: flutter capabilities: gym fitness members workouts',
        ],
      ],
    });
    draft = await item({
      name: 'Private Draft Store',
      published: false,
      docs: [['SUMMARY', 'summary', 'Private Draft Store', 'store checkout cart perfect match']],
    });
    await item({
      name: 'No Reuse Dashboard',
      scope: 'NONE',
      docs: [['SUMMARY', 'summary', 'No Reuse Dashboard', 'dashboard analytics']],
    });
    await item({
      name: 'Restricted Licence Dashboard',
      license: 'RESTRICTED',
      docs: [['SUMMARY', 'summary', 'Restricted Licence Dashboard', 'dashboard analytics']],
    });
  }, 180_000);

  it('hard filters run BEFORE ranking: private, unpermitted and restricted resources are never ranked and are listed with every reason', async () => {
    const r = ok<Row>(await rec({ text: 'store with checkout and cart', platform: 'WEB' }));
    expect(names(r.ranked as Row[])).toEqual(expect.arrayContaining(['Store Starter']));
    expect(names(r.ranked as Row[])).not.toContain('Private Draft Store'); // the better text match is not published
    const ex = Object.fromEntries((r.excluded as Row[]).map((x) => [x.name, x.reasons]));
    expect(ex['Private Draft Store']).toEqual(['not_published']);
    expect(ex['No Reuse Dashboard']).toEqual(['no_reuse_permission']);
    expect(ex['Restricted Licence Dashboard']).toEqual(['license_not_allowed']);
    expect(ex['Gym Mobile']).toEqual(['platform_incompatible']);
    expect(r.stats).toMatchObject({ considered: expect.any(Number), eligible: expect.any(Number) });
    expect((r.stats as Row).eligible as number).toBeGreaterThanOrEqual(2);
  });

  it('an Arabic requirement finds the same resource as the English one; the strategy auto-selects it and every score is explained', async () => {
    const ar = ok<Row>(await rec({ text: 'أريد متجر إلكتروني', platform: 'WEB' }));
    const en = ok<Row>(await rec({ text: 'online shop', platform: 'WEB' }));
    expect(names(ar.ranked as Row[])[0]).toBe('Store Starter');
    expect(names(en.ranked as Row[])[0]).toBe('Store Starter');
    expect(ar.decision).toMatchObject({
      strategy: 'AUTO_SELECT',
      selectedResourceId: store.resourceId,
      notes: ['auto_selected'],
    });
    const top = (ar.ranked as Row[])[0]!;
    expect(top.versionId).toBe(store.versionId); // the pinned, ACTIVE version
    const dims = top.dimensions as Row[];
    expect(dims.map((d) => d.dimension)).toEqual([
      'functional',
      'framework',
      'architecture',
      'design',
      'quality',
      'reuse',
    ]);
    expect(dims.find((d) => d.dimension === 'functional')).toMatchObject({
      applicable: true,
      note: 'functional.coverage',
    });
    expect(dims.find((d) => d.dimension === 'framework')).toMatchObject({ applicable: false });
    expect(dims.find((d) => d.dimension === 'quality')).toMatchObject({
      applicable: false,
      note: 'quality.not_measured',
    });
    expect((top.matches as Row[]).length).toBeGreaterThan(0);
    expect(top.usage).toMatchObject({ recommended: 'FULL_STARTER' });
    expect(ar.settings).toMatchObject({
      revision: 0,
      minScore: 35,
      weights: {
        functional: 25,
        framework: 20,
        architecture: 20,
        design: 15,
        quality: 10,
        reuse: 10,
      },
    });
  });

  it('design hints, frameworks, quality and architecture all enter the score with the D-48 weights', async () => {
    const r = ok<Row>(
      await rec({
        text: 'admin dashboard',
        platform: 'WEB',
        frameworks: ['next.js'],
        design: { darkMode: true, rtl: true, primaryColor: '#2563eb' },
      }),
    );
    const top = (r.ranked as Row[])[0]!;
    expect(top.name).toBe('Admin Dashboard Pro');
    const dims = Object.fromEntries((top.dimensions as Row[]).map((d) => [d.dimension, d]));
    expect(dims.design).toMatchObject({ applicable: true, score: 1 });
    expect(dims.framework).toMatchObject({ applicable: true, score: 1 });
    expect(dims.quality).toMatchObject({ applicable: true, score: 0.9 });
    expect(dims.architecture.applicable).toBe(true);
    expect(top.confidence).toBe(100);
    expect(top.score as number).toBeGreaterThan(90);
    // the same requirement without the design hints scores the dashboard lower on design only
    const other = ok<Row>(
      await rec({ text: 'admin dashboard', platform: 'WEB', design: { darkMode: false } }),
    );
    expect(
      ((other.ranked as Row[])[0]!.dimensions as Row[]).find((d) => d.dimension === 'design'),
    ).toMatchObject({ score: 0 });
  });

  it('a user choice is honoured when eligible and NEVER substituted when not: it is explained and the alternatives are offered', async () => {
    const good = ok<Row>(
      await rec({ strategy: 'USER_SELECTED', resourceId: dash.resourceId, text: 'store' }),
    );
    expect(good.decision).toMatchObject({
      strategy: 'USER_SELECTED',
      selectedResourceId: dash.resourceId,
      notes: ['user_choice_honoured'],
    });
    const bad = ok<Row>(
      await rec({ strategy: 'USER_SELECTED', resourceId: draft.resourceId, text: 'store' }),
    );
    expect(bad.decision).toMatchObject({
      strategy: 'USER_SELECTED',
      selectedResourceId: null,
      notes: ['user_choice_ineligible'],
    });
    expect(bad.selected).toBeNull();
    expect(bad.userChoice).toMatchObject({
      resourceId: draft.resourceId,
      name: 'Private Draft Store',
      reasons: ['not_published'],
    });
    expect((bad.alternatives as Row[]).length).toBeGreaterThan(0); // offered, not applied
    const unknown = ok<Row>(await rec({ strategy: 'USER_SELECTED', resourceId: randomUUID() }));
    expect(unknown.userChoice).toMatchObject({ reasons: ['not_found'] });
  });

  it('adaptation mode and AI processing are hard filters too', async () => {
    const strict = ok<Row>(await rec({ mode: 'STRICT', platform: 'MOBILE' }));
    expect((strict.excluded as Row[]).find((x) => x.name === 'Gym Mobile')!.reasons).toEqual([
      'mode_needs_starter',
    ]);
    const adaptive = ok<Row>(await rec({ mode: 'ADAPTIVE', platform: 'MOBILE' }));
    expect(names(adaptive.ranked as Row[])).toContain('Gym Mobile');
    expect(((adaptive.ranked as Row[])[0]!.usage as Row).recommended).toBe('COMPONENTS');
    const ai = ok<Row>(await rec({ platform: 'MOBILE', requiresAiProcessing: true }));
    expect((ai.excluded as Row[]).find((x) => x.name === 'Gym Mobile')!.reasons).toEqual([
      'ai_processing_not_allowed',
    ]);
    const fw = ok<Row>(await rec({ frameworks: ['flutter'], frameworksRequired: true }));
    expect(names(fw.ranked as Row[])).toEqual(['Gym Mobile']);
  });

  it('nothing relevant: generate from scratch, with the reason', async () => {
    const r = ok<Row>(await rec({ text: 'quantum telescope scheduler' }));
    expect(r.decision).toMatchObject({
      strategy: 'GENERATE_FROM_SCRATCH',
      selectedResourceId: null,
      notes: ['below_min_score'],
    });
    expect((r.ranked as Row[]).length).toBeGreaterThan(0); // still ranked and explained, just not selected
    const none = ok<Row>(await rec({ platform: 'BACKEND' }));
    expect(none.decision).toMatchObject({
      strategy: 'GENERATE_FROM_SCRATCH',
      notes: ['no_eligible_resource'],
    });
    expect(
      ok<Row>(await rec({ strategy: 'GENERATE_FROM_SCRATCH', text: 'store' })).decision,
    ).toMatchObject({ strategy: 'GENERATE_FROM_SCRATCH', selectedResourceId: null });
  });

  it('admin defaults: a preference that still passes every check, and a pin that must match the active version', async () => {
    expect(
      (
        await admin('psupport2', 'PUT', `${R}/defaults`, {
          platform: 'WEB',
          resourceId: store.resourceId,
        })
      ).statusCode,
    ).toBe(403);
    const set = ok<Row>(
      await admin('padmin', 'PUT', `${R}/defaults`, {
        platform: 'WEB',
        resourceId: store.resourceId,
      }),
    );
    expect(set).toMatchObject({
      platform: 'WEB',
      framework: '*',
      resourceId: store.resourceId,
      resourceName: 'Store Starter',
    });
    // replaced, not duplicated
    ok<Row>(
      await admin('padmin', 'PUT', `${R}/defaults`, {
        platform: 'WEB',
        resourceId: store.resourceId,
      }),
    );
    expect(
      ok<{ items: Row[] }>(await admin('psupport2', 'GET', `${R}/defaults`)).items.filter(
        (x) => x.platform === 'WEB',
      ),
    ).toHaveLength(1);
    const used = ok<Row>(
      await rec({ strategy: 'ADMIN_DEFAULT', platform: 'WEB', text: 'admin dashboard analytics' }),
    );
    expect(used.decision).toMatchObject({
      strategy: 'ADMIN_DEFAULT',
      selectedResourceId: store.resourceId,
      notes: ['admin_default_used'],
    });
    expect(names(used.ranked as Row[])[0]).toBe('Admin Dashboard Pro'); // the ranking itself is unaffected
    // a default that is not eligible is not used: the automatic choice is, and says why
    ok<Row>(
      await admin('padmin', 'PUT', `${R}/defaults`, {
        platform: 'WEB',
        resourceId: draft.resourceId,
      }),
    );
    const fall = ok<Row>(
      await rec({ strategy: 'ADMIN_DEFAULT', platform: 'WEB', text: 'admin dashboard analytics' }),
    );
    expect(fall.decision).toMatchObject({
      strategy: 'AUTO_SELECT',
      notes: ['admin_default_ineligible', 'auto_selected'],
    });
    // a pin to another version of the resource is refused unless it is a version of that resource; a wrong pin makes the default ineligible
    expect(
      (
        await admin('padmin', 'PUT', `${R}/defaults`, {
          platform: 'WEB',
          resourceId: store.resourceId,
          versionPin: dash.versionId,
        })
      ).statusCode,
    ).toBe(422);
    const other = await submit(
      'padmin',
      { provenanceClass: 'FIRST_PARTY' },
      'Store Starter',
      store.resourceId,
    );
    ok<Row>(
      await admin('padmin', 'PUT', `${R}/defaults`, {
        platform: 'WEB',
        resourceId: store.resourceId,
        versionPin: other.versionId,
      }),
    );
    const pinned = ok<Row>(
      await rec({ strategy: 'ADMIN_DEFAULT', platform: 'WEB', text: 'store' }),
    );
    expect(pinned.adminDefault).toMatchObject({
      resourceId: store.resourceId,
      eligible: false,
      reasons: ['pinned_version_unavailable'],
    });
    expect(pinned.decision).toMatchObject({ strategy: 'AUTO_SELECT' });
    // remove it
    const id = ok<{ items: Row[] }>(await admin('padmin', 'GET', `${R}/defaults`)).items.find(
      (x) => x.platform === 'WEB',
    )!.id as string;
    ok<Row>(await admin('padmin', 'DELETE', `${R}/defaults/${id}`));
    expect((await admin('padmin', 'DELETE', `${R}/defaults/${id}`)).statusCode).toBe(404);
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${R}/defaults`)).items.filter(
        (x) => x.platform === 'WEB',
      ),
    ).toHaveLength(0);
    expect(
      e.sink.events
        .filter((x) => String(x.action).startsWith('knowledge.default.'))
        .map((x) => x.action),
    ).toEqual(expect.arrayContaining(['knowledge.default.set', 'knowledge.default.removed']));
  });

  it('the weights are configurable with an audit trail: optimistic revision, a reason, valid integers, publish permission', async () => {
    const cur = ok<Row>(await admin('psupport2', 'GET', `${R}/settings/recommendation`));
    expect(cur).toMatchObject({ revision: 0, isDefault: true, minScore: 35 });
    const w = {
      functional: 40,
      framework: 10,
      architecture: 10,
      design: 10,
      quality: 10,
      reuse: 20,
    };
    const put = (who: string, ifMatch: string | undefined, b: Row) =>
      admin(
        who,
        'PUT',
        `${R}/settings/recommendation`,
        b,
        ifMatch === undefined ? {} : { 'if-match': ifMatch },
      );
    expect(
      (
        await put('psupport2', '0', {
          weights: w,
          minScore: 40,
          reason: 'Prefer functional fit for launch.',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await put('padmin', undefined, {
          weights: w,
          minScore: 40,
          reason: 'Prefer functional fit for launch.',
        })
      ).statusCode,
    ).toBe(422);
    for (const bad of [
      {
        weights: { ...w, functional: 41 },
        minScore: 40,
        reason: 'Does not add up to one hundred.',
      },
      {
        weights: { ...w, functional: 40.5, reuse: 19.5 },
        minScore: 40,
        reason: 'Fractions are not allowed here.',
      },
      { weights: w, minScore: 101, reason: 'The minimum score is too high.' },
      { weights: w, minScore: 40, reason: 'short' },
      { weights: { ...w, extra: 0 }, minScore: 40, reason: 'Unknown weights are refused.' },
    ])
      expect((await put('padmin', '0', bad)).statusCode, JSON.stringify(bad)).toBe(422);
    expect(
      (await put('padmin', '5', { weights: w, minScore: 40, reason: 'Stale revision on purpose.' }))
        .statusCode,
    ).toBe(412);
    const done = ok<Row>(
      await put('padmin', '0', {
        weights: w,
        minScore: 40,
        reason: 'Prefer functional fit for launch.',
      }),
    );
    expect(done).toMatchObject({
      revision: 1,
      isDefault: false,
      minScore: 40,
      weights: w,
      updatedBy: e.ids.padmin,
    });
    // a second writer with the old revision loses
    expect(
      (
        await put('padmin', '0', {
          weights: w,
          minScore: 40,
          reason: 'Second writer, old revision.',
        })
      ).statusCode,
    ).toBe(412);
    // the new weights are the ones the recommendation uses, and it says which revision
    const r = ok<Row>(await rec({ text: 'online shop', platform: 'WEB' }));
    expect(r.settings).toMatchObject({ revision: 1, minScore: 40, weights: w });
    // history: who, why, what, and the previous value
    const hist = ok<{ items: Row[] }>(
      await admin('psupport2', 'GET', `${R}/settings/recommendation/revisions`),
    );
    expect(hist.items[0]).toMatchObject({
      revision: 1,
      reason: 'Prefer functional fit for launch.',
      changedBy: e.ids.padmin,
      previous: null,
      value: { minScore: 40 },
    });
    const second = ok<Row>(
      await put('padmin', '1', {
        weights: {
          functional: 25,
          framework: 20,
          architecture: 20,
          design: 15,
          quality: 10,
          reuse: 10,
        },
        minScore: 35,
        reason: 'Back to the initial configuration.',
      }),
    );
    expect(second.revision).toBe(2);
    const hist2 = ok<{ items: Row[] }>(
      await admin('psupport2', 'GET', `${R}/settings/recommendation/revisions`),
    );
    expect(hist2.items.map((x) => x.revision)).toEqual([2, 1]);
    expect((hist2.items[0]!.previous as Row).minScore).toBe(40);
    expect(
      e.sink.events
        .filter((x) => x.action === 'knowledge.settings.updated')
        .map((x) => (x.detail as Row).revision),
    ).toEqual([1, 2]);
    // the history is append-only in the database
    await expect(e.sql(`DELETE FROM knowledge.engine_setting_revisions`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      e.sql(`UPDATE knowledge.engine_setting_revisions SET reason = 'x'`),
    ).rejects.toThrow(/append-only/);
  });

  it('search: Arabic and English, structured filters, eligibility with reasons, symbol/component matches; hostile text is data', async () => {
    const ar = ok<{ items: Row[]; query: Row; total: number }>(
      await admin(
        'psupport2',
        'GET',
        `${R}/search?q=${encodeURIComponent('لوحة تحكم')}&mode=ADAPTIVE`,
      ),
    );
    expect(ar.items[0]!.name).toBe('Admin Dashboard Pro');
    expect(ar.items[0]).toMatchObject({
      relevance: expect.any(Number),
      eligibility: { eligible: true, reasons: [] },
    });
    expect((ar.query.groups as Row[]).map((g) => g.key)).toEqual(['dashboard']);
    const en = ok<{ items: Row[] }>(await admin('psupport2', 'GET', `${R}/search?q=data+table`));
    expect(en.items[0]!.name).toBe('Admin Dashboard Pro');
    expect((en.items[0]!.components as Row[])[0]!.name).toBe('DataTable'); // a symbol/component match with its evidence
    const dashboards = ok<{ items: Row[] }>(
      await admin('padmin', 'GET', `${R}/search?q=dashboard&eligible=false`),
    );
    const inel = Object.fromEntries(
      dashboards.items.map((x) => [x.name, (x.eligibility as Row).reasons]),
    );
    expect(inel['No Reuse Dashboard']).toEqual(['no_reuse_permission']);
    expect(inel['Restricted Licence Dashboard']).toEqual(['license_not_allowed']);
    expect(inel['Admin Dashboard Pro']).toBeUndefined();
    const web = ok<{ items: Row[] }>(await admin('padmin', 'GET', `${R}/search?platform=MOBILE`));
    expect(names(web.items)).toEqual(['Gym Mobile']);
    expect(
      names(
        ok<{ items: Row[] }>(await admin('padmin', 'GET', `${R}/search?framework=flutter`)).items,
      ),
    ).toEqual(['Gym Mobile']);
    expect(
      ok<{ items: Row[] }>(await admin('padmin', 'GET', `${R}/search?limit=2`)).items,
    ).toHaveLength(2);
    // injection attempts and operators are plain text
    for (const hostile of [
      "'; DROP TABLE knowledge.resources; --",
      'a & b | !c',
      'foo:* <-> bar',
      '(((',
      '%',
      'x'.repeat(250),
    ]) {
      const r = await admin('padmin', 'GET', `${R}/search?q=${encodeURIComponent(hostile)}`);
      expect(r.statusCode, hostile).toBe(200);
    }
    expect((await e.sql(`SELECT count(*)::int n FROM knowledge.resources`))[0]!.n).toBeGreaterThan(
      5,
    );
    for (const bad of ['platform=nope', 'mode=nope', 'eligible=maybe'])
      expect((await admin('padmin', 'GET', `${R}/search?${bad}`)).statusCode).toBe(422);
    expect((await e.call('alice', 'GET', `${R}/search?q=store`)).statusCode).not.toBe(200);
  });

  it('validates the requirement, never writes, and customers cannot reach it', async () => {
    for (const bad of [
      { mode: 'WILD' },
      { platform: 'TV' },
      { frameworks: Array.from({ length: 11 }, (_, i) => `f${i}`) },
      { frameworks: [1] },
      { design: { primaryColor: 'not-a-colour' } },
      { design: { darkMode: 'yes' } },
      { limit: 0 },
      { limit: 21 },
      { text: 'x'.repeat(30_001) },
      { strategy: 'NOPE' },
      { strategy: 'USER_SELECTED' },
      { resourceId: 'x' },
      { frameworksRequired: 'true' },
    ])
      expect((await rec(bad)).statusCode, JSON.stringify(bad)).toBe(422);
    const count = async () =>
      JSON.stringify(
        await e.sql(
          `SELECT (SELECT count(*) FROM knowledge.usage_events) a, (SELECT count(*) FROM knowledge.resource_search_documents) b, (SELECT count(*) FROM knowledge.theme_tokens) c, (SELECT count(*) FROM knowledge.template_defaults) d, (SELECT count(*) FROM knowledge.engine_settings) f`,
        ),
      );
    const before = await count();
    ok<Row>(await rec({ text: 'store', platform: 'WEB' }));
    ok<Row>(await rec({ strategy: 'ADMIN_DEFAULT', text: 'store' }));
    expect(await count()).toBe(before);
    expect(
      (await e.call('alice', 'POST', `${R}/recommendations`, { text: 'store' })).statusCode,
    ).not.toBe(200);
  });

  it('is deterministic: the same requirement gives the same ranking and explanation', async () => {
    const body = { text: 'dashboard store', platform: 'WEB', design: { darkMode: true } };
    const a = ok<Row>(await rec(body));
    const b = ok<Row>(await rec(body));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('retries the indexing stage when it was the one interrupted', async () => {
    const s = await submit();
    await analysed(s);
    await e.sql(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind, state, finished_at) VALUES (gen_random_uuid(),$1,NULL,'INDEX','FAILED',now())`,
      [s.versionId],
    );
    await e.sql(
      `UPDATE knowledge.resource_versions SET state = 'QUARANTINED', state_reason = 'processing_failed' WHERE id = $1`,
      [s.versionId],
    );
    const r = ok<Row>(
      await admin(
        'padmin',
        'POST',
        `${R}/resources/${s.resourceId}/versions/${s.versionId}/reprocessing`,
        {},
      ),
    );
    expect(
      (await e.sql(`SELECT kind FROM knowledge.processing_jobs WHERE id = $1`, [r.jobId]))[0]!.kind,
    ).toBe('INDEX');
  });
});

describe('customer templates (S-K7)', () => {
  const T = '/v1/builder/templates';
  const MIT =
    'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
  const star = (extra: Item['files'] = []): NonNullable<Item['files']> => [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: 'starter',
        version: '1.0.0',
        dependencies: { next: '15.0.0', react: '19.0.0' },
      }),
    },
    { path: 'README.md', content: '# Starter\n\nA dashboard starter.\n' },
    { path: 'LICENSE', content: MIT },
    {
      path: 'src/app/page.tsx',
      content: 'export default function Home() { return <main>Home</main>; }\n',
    },
    { path: 'src/app/globals.css', content: ':root { --primary: #2563eb; }\n' },
    { path: 'public/logo.png', content: 'PNG', binary: true },
    { path: 'docs/big.txt', content: 'x', bytes: 2_000_000 },
    { path: 'assets/table.txt', content: 'a\u0000b' },
    ...extra,
  ];
  let t1: { resourceId: string; versionId: string };
  let t2: { resourceId: string; versionId: string };
  let t3: { resourceId: string; versionId: string };
  let leaky: { resourceId: string; versionId: string };
  let missing: { resourceId: string; versionId: string };
  let tampered: { resourceId: string; versionId: string };
  const A = () => e.org.A!;
  const B = () => e.org.B!;
  const call = (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    body?: object,
    org = A(),
    extra: Record<string, string> = {},
  ) => e.call(who, method, url, body, org, extra);
  const idem = () => ({ 'idempotency-key': randomUUID() });
  const flag = (key: string, org: string | null, on = true) =>
    e.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
      [key, org, JSON.stringify(on)],
    );
  const projectCount = async (org: string) =>
    Number(
      (
        await e.sql(
          `SELECT count(*)::int n FROM builder.projects WHERE org_id = $1 AND deleted_at IS NULL`,
          [org],
        )
      )[0]!.n,
    );
  const events = async (org: string, kind: string) =>
    Number(
      (
        await e.sql(
          `SELECT count(*)::int n FROM knowledge.usage_events WHERE org_id = $1 AND kind = $2`,
          [org, kind],
        )
      )[0]!.n,
    );
  const names = (xs: Row[]) => xs.map((x) => x.name as string);
  /** the library is shared with the other suites' fixtures: this suite's own templates are picked out of every listing */
  const MINE = [
    'Components Library',
    'Leaky Template',
    'Missing Object',
    'Mobile Kit',
    'Starter Dashboard',
    'Tampered Object',
  ];
  const mine = (xs: Row[]) => names(xs).filter((n) => MINE.includes(n));

  beforeAll(async () => {
    t1 = await item({
      name: 'Starter Dashboard',
      description: 'متجر ولوحة تحكم',
      capabilities: ['Authentication', 'Dashboard'],
      dna: {
        schemaVersion: '1',
        primary: 0,
        projects: [
          {
            modes: ['base'],
            traits: { darkMode: true },
            palette: [
              {
                mode: 'base',
                roles: [
                  {
                    role: 'primary',
                    hex: '#2563eb',
                    token: '--primary',
                    evidence: { path: 'src/secret/globals.css', line: 1 },
                  },
                ],
              },
            ],
            typography: { families: [{ value: 'Cairo' }] },
            spacing: { baseUnit: 4 },
          },
        ],
      },
      files: star(),
    });
    t2 = await item({
      name: 'Components Library',
      scope: 'COMPONENTS',
      starter: false,
      files: [{ path: 'src/button.tsx', content: 'export const Button = () => null;\n' }],
    });
    t3 = await item({ name: 'Hidden Draft', published: false, files: star() });
    await item({
      name: 'Mobile Kit',
      platform: 'MOBILE',
      frameworks: ['flutter'],
      files: [{ path: 'lib/main.dart', content: 'void main() {}\n' }],
    });
    leaky = await item({
      name: 'Leaky Template',
      files: [
        { path: 'package.json', content: '{"name":"x"}' },
        {
          path: 'src/keys.ts',
          content: `export const k = \`${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\nabc\n${['-----END', 'PRIVATE KEY-----'].join(' ')}\`;\n` /* assembled at run time: the scanner must find it in the stored file, not in this source */,
        },
      ],
    });
    missing = await item({
      name: 'Missing Object',
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n', missing: true }],
    });
    tampered = await item({
      name: 'Tampered Object',
      files: [{ path: 'src/a.ts', content: 'export const a = 1;\n', tampered: true }],
    });
  }, 300_000);

  it('is OFF by default and per organization: every customer route answers 404 until the flag is on for that organization', async () => {
    for (const [m, u] of [
      ['GET', T],
      ['GET', `${T}/${t1.resourceId}`],
      ['POST', '/v1/builder/template-recommendations'],
      ['POST', '/v1/builder/projects/from-template'],
      ['POST', '/v1/builder/generation-plans'],
      ['GET', `/v1/builder/generation-plans/${randomUUID()}`],
    ] as const)
      expect(
        (await call('alice', m, u, m === 'POST' ? {} : undefined, A(), m === 'POST' ? idem() : {}))
          .statusCode,
        `${m} ${u}`,
      ).toBe(404);
    await flag('knowledge.customer_templates', A());
    expect((await call('alice', 'GET', T)).statusCode).toBe(200);
    expect((await call('bob', 'GET', T, undefined, B())).statusCode).toBe(404); // another organization is still off
    await flag('knowledge.customer_templates', B());
    for (const org of [A(), B()]) await flag('app_builder.enabled', org);
    expect((await call('bob', 'GET', T, undefined, B())).statusCode).toBe(200);
  });

  it('the gallery lists published templates only, with metadata and a safe design summary, and never anything that locates source', async () => {
    const r = ok<{ items: Row[]; nextCursor: string | null }>(await call('alice', 'GET', T));
    expect(mine(r.items)).toEqual(MINE); // every published one, never the unpublished draft
    expect(names(r.items)).not.toContain('Hidden Draft');
    const dash = r.items.find((x) => x.name === 'Starter Dashboard')!;
    expect(dash).toMatchObject({
      id: t1.resourceId,
      versionId: t1.versionId,
      platform: 'WEB',
      ownership: 'PLATFORM',
      capabilities: ['Authentication', 'Dashboard'],
      license: { verdict: 'ALLOWED' },
    });
    expect(dash.design).toEqual({
      modes: ['base'],
      traits: { darkMode: true },
      roles: [{ role: 'primary', hex: '#2563eb' }],
      families: ['Cairo'],
      baseUnit: 4,
    });
    expect((dash.reuse as Row).usages).toEqual(['FULL_STARTER', 'COMPONENTS', 'ARCHITECTURE_ONLY']);
    // nothing that locates source or reveals the library's internals
    const all = JSON.stringify(r);
    for (const leak of [
      'src/secret',
      'snapshots/',
      'object_key',
      'objectKey',
      'src/app/page.tsx',
      'package.json',
      'archive',
      'sha256',
      'checksum',
      'evidence',
      '--primary',
    ])
      expect(all, leak).not.toContain(leak);
    // viewers may read; the pages and filters work
    expect((await call('carol', 'GET', T)).statusCode).toBe(200);
    expect(
      mine(ok<{ items: Row[] }>(await call('alice', 'GET', `${T}?platform=MOBILE`)).items),
    ).toEqual(['Mobile Kit']);
    expect(
      mine(ok<{ items: Row[] }>(await call('alice', 'GET', `${T}?framework=Flutter`)).items),
    ).toEqual(['Mobile Kit']);
    expect(
      mine(
        ok<{ items: Row[] }>(
          await call('alice', 'GET', `${T}?q=${encodeURIComponent('لوحة تحكم')}`),
        ).items,
      ),
    ).toEqual(['Starter Dashboard']);
    expect(
      names(
        ok<{ items: Row[] }>(
          await call('alice', 'GET', `${T}?q=${encodeURIComponent("'; DROP TABLE x; --")}`),
        ).items,
      ),
    ).toEqual([]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const pg: { items: Row[]; nextCursor: string | null } = ok(
        await call('alice', 'GET', `${T}?limit=4${cursor ? `&cursor=${cursor}` : ''}`),
      );
      expect(pg.items.length).toBeLessThanOrEqual(4);
      seen.push(...names(pg.items));
      expect(new Set(seen).size).toBe(seen.length);
      cursor = pg.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(names(r.items)); // the pages add up to the whole list, in the same order, once each
    expect((await call('alice', 'GET', `${T}?type=NOPE`)).statusCode).toBe(422);
    expect((await call('alice', 'GET', `${T}?cursor=garbage`)).statusCode).toBe(422);
  });

  it('one template: 200 for a published one; 404 for an unpublished one, an unknown id and a malformed id (indistinguishable)', async () => {
    expect(ok<Row>(await call('alice', 'GET', `${T}/${t1.resourceId}`))).toMatchObject({
      name: 'Starter Dashboard',
    });
    const miss = [`${T}/${t3.resourceId}`, `${T}/${randomUUID()}`, `${T}/not-an-id`];
    const bodies = new Set<string>();
    for (const u of miss) {
      const r = await call('alice', 'GET', u);
      expect(r.statusCode, u).toBe(404);
      bodies.add(r.json().code as string);
    }
    expect(bodies.size).toBe(1);
  });

  it('recommendations are answered for a customer: ranked eligible templates and nothing about resources it may not see', async () => {
    const before = await events(A(), 'RECOMMENDED');
    const r = ok<Row>(
      await call('alice', 'POST', '/v1/builder/template-recommendations', {
        text: 'لوحة تحكم',
        platform: 'WEB',
      }),
    );
    expect(names(r.ranked as Row[])).toContain('Starter Dashboard');
    expect(['Admin Dashboard Pro', 'Starter Dashboard']).toContain(names(r.ranked as Row[])[0]); // the strongest dashboards of a shared library
    expect(r.decision).toMatchObject({ strategy: 'AUTO_SELECT' });
    for (const hidden of ['excluded', 'adminDefault', 'settings'])
      expect(r).not.toHaveProperty(hidden);
    expect(r.stats).not.toHaveProperty('considered');
    const all = JSON.stringify(r);
    for (const leak of ['Hidden Draft', 'src/', 'snippet', 'matches', 'not_published'])
      expect(all, leak).not.toContain(leak);
    expect(((r.ranked as Row[])[0]!.dimensions as Row[]).map((d) => d.dimension)).toEqual([
      'functional',
      'framework',
      'architecture',
      'design',
      'quality',
      'reuse',
    ]);
    expect(await events(A(), 'RECOMMENDED')).toBeGreaterThan(before); // the customer's own usage events
    expect(await events(B(), 'RECOMMENDED')).toBe(0);
    // the decision and its reasons are recorded (selected template and components, reason codes, scores of what was considered), never the customer's text
    const rec = e.sink.events.filter((x) => x.action === 'knowledge.template.recommended').at(-1)
      ?.detail as Row | undefined;
    expect(rec, 'the recommendation is audited').toBeDefined();
    expect(rec).toMatchObject({ strategy: 'AUTO_SELECT', textChars: 'لوحة تحكم'.length });
    expect(Array.isArray(rec!.reasons)).toBe(true);
    expect((rec!.considered as Row[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(rec)).not.toContain('لوحة');
  });

  it("a user's choice: an eligible one is honoured; one the customer may not see is 'not found'; an unusable but visible one is explained; nothing is substituted", async () => {
    const ok1 = ok<Row>(
      await call('alice', 'POST', '/v1/builder/template-recommendations', {
        strategy: 'USER_SELECTED',
        resourceId: t1.resourceId,
      }),
    );
    expect(ok1.decision).toMatchObject({
      strategy: 'USER_SELECTED',
      selectedResourceId: t1.resourceId,
    });
    const hidden = ok<Row>(
      await call('alice', 'POST', '/v1/builder/template-recommendations', {
        strategy: 'USER_SELECTED',
        resourceId: t3.resourceId,
      }),
    );
    expect(hidden.decision).toMatchObject({ selectedResourceId: null });
    expect(hidden.userChoice).toEqual({ resourceId: t3.resourceId, reasons: ['not_found'] }); // not "not published": that would say it exists
    expect(hidden.alternatives).toEqual([]);
    const strict = ok<Row>(
      await call('alice', 'POST', '/v1/builder/template-recommendations', {
        strategy: 'USER_SELECTED',
        resourceId: t2.resourceId,
        mode: 'STRICT',
      }),
    );
    expect(strict.userChoice).toEqual({
      resourceId: t2.resourceId,
      reasons: ['mode_needs_starter'],
    });
    expect(strict.selected).toBeNull();
    expect(
      (await call('alice', 'POST', '/v1/builder/template-recommendations', { mode: 'WILD' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/builder/template-recommendations', {
          design: { primaryColor: 'x' },
        })
      ).statusCode,
    ).toBe(422);
  });

  it('from-template: the pinned version is copied into a NEW web-app project through the safe pipeline; the template is untouched; everything is recorded', async () => {
    expect(
      (
        await call(
          'carol',
          'POST',
          '/v1/builder/projects/from-template',
          { resourceId: t1.resourceId, name: 'X' },
          A(),
          idem(),
        )
      ).statusCode,
    ).toBe(403); // a viewer cannot write
    expect(
      (
        await call(
          'alice',
          'POST',
          '/v1/builder/projects/from-template',
          { resourceId: t1.resourceId, name: 'No Key' },
          A(),
          { 'idempotency-key': '' },
        )
      ).statusCode,
    ).toBe(400);
    const projectsBefore = await projectCount(A());
    const copied0 = await events(A(), 'COPIED');
    const key = randomUUID();
    const r1 = await call(
      'alice',
      'POST',
      '/v1/builder/projects/from-template',
      {
        resourceId: t1.resourceId,
        versionId: t1.versionId,
        name: 'My Dashboard',
        adaptationMode: 'ADAPTIVE',
      },
      A(),
      { 'idempotency-key': key },
    );
    const res = ok<Row>(r1, 201);
    expect(res.project).toMatchObject({ name: 'My Dashboard', type: 'webapp' });
    expect(res.template).toMatchObject({
      resourceId: t1.resourceId,
      versionId: t1.versionId,
      name: 'Starter Dashboard',
      mode: 'ADAPTIVE',
      usage: 'FULL_STARTER',
    });
    expect(res.license).toEqual({ spdx: 'MIT' });
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    const files = res.files as { copied: number; skipped: { path: string; reason: string }[] };
    expect(files.copied).toBe(5); // package.json, README.md, LICENSE, page.tsx, globals.css
    expect(files.skipped).toEqual(
      expect.arrayContaining([
        { path: 'assets/table.txt', reason: 'binary' },
        { path: 'docs/big.txt', reason: 'too_large' },
      ]),
    );
    expect(JSON.stringify(res)).not.toMatch(/snapshots\/|objectKey|object_key/);
    // the project really holds the template's files
    const proj = (
      await e.sql(`SELECT id, type, head_version_id FROM builder.projects WHERE id = $1`, [
        (res.project as Row).id,
      ])
    )[0]!;
    expect(proj).toMatchObject({ type: 'webapp' });
    const fs = (await e.app
      .get<ProjectsPort>(ProjectsPort)
      .readFiles(A(), proj.id as string, proj.head_version_id as string))!;
    expect([...fs.keys()].sort()).toEqual([
      'LICENSE',
      'README.md',
      'package.json',
      'src/app/globals.css',
      'src/app/page.tsx',
    ]);
    expect(fs.get('src/app/page.tsx')).toBe(
      'export default function Home() { return <main>Home</main>; }\n',
    );
    expect(fs.get('LICENSE')).toContain('MIT License'); // the licence travels with the copy
    // recorded: usage, the link from the version to the copy, audit; the customer's own rows only
    expect(await events(A(), 'COPIED')).toBe(copied0 + 1);
    expect(await events(A(), 'SELECTED')).toBeGreaterThan(0);
    const link = (
      await e.sql(
        `SELECT resource_version_id, role, strategy FROM knowledge.generation_resource_links WHERE org_id = $1`,
        [A()],
      )
    )[0]!;
    expect(link).toMatchObject({
      resource_version_id: t1.versionId,
      role: 'STARTER',
      strategy: 'COPY',
    });
    const audit = e.sink.events.filter((x) => x.action === 'knowledge.template.copied');
    expect(audit.at(-1)).toMatchObject({
      orgId: A(),
      outcome: 'success',
      detail: {
        resourceId: t1.resourceId,
        versionId: t1.versionId,
        mode: 'ADAPTIVE',
        copied: 5,
        skipped: 2,
      },
    });
    // the same key replays the first answer; no second project
    const r2 = await call(
      'alice',
      'POST',
      '/v1/builder/projects/from-template',
      {
        resourceId: t1.resourceId,
        versionId: t1.versionId,
        name: 'My Dashboard',
        adaptationMode: 'ADAPTIVE',
      },
      A(),
      { 'idempotency-key': key },
    );
    expect(r2.statusCode).toBe(201);
    expect((r2.json() as Row).project).toEqual(res.project);
    expect(await projectCount(A())).toBe(projectsBefore + 1);
    // the template is immutable: its files and the recorded inventory are as they were
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*)::int n FROM knowledge.resource_files WHERE version_id = $1`,
            [t1.versionId],
          )
        )[0]!.n,
      ),
    ).toBe(8);
    // a second copy is independent of the first
    const second = ok<Row>(
      await call(
        'alice',
        'POST',
        '/v1/builder/projects/from-template',
        { resourceId: t1.resourceId, name: 'Second Copy' },
        A(),
        idem(),
      ),
      201,
    );
    expect((second.project as Row).id).not.toBe((res.project as Row).id);
    // another organization cannot see this project; its own copy is its own
    expect(
      (await call('bob', 'GET', `/v1/builder/projects/${(res.project as Row).id}`, undefined, B()))
        .statusCode,
    ).toBe(404);
    const bobs = ok<Row>(
      await call(
        'bob',
        'POST',
        '/v1/builder/projects/from-template',
        { resourceId: t1.resourceId, name: 'Bob Dashboard' },
        B(),
        idem(),
      ),
      201,
    );
    expect(await projectCount(B())).toBe(1);
    expect(await events(B(), 'COPIED')).toBe(1);
    expect((bobs.project as Row).id).not.toBe((res.project as Row).id);
  });

  it('refusals leave nothing behind: unpublished, wrong mode, a changed pin, a taken name, secrets in the template, a missing or tampered object', async () => {
    const before = { projects: await projectCount(A()), copied: await events(A(), 'COPIED') };
    const go = (body: Row) =>
      call('alice', 'POST', '/v1/builder/projects/from-template', body, A(), idem());
    expect((await go({ resourceId: t3.resourceId, name: 'Draft Copy' })).statusCode).toBe(404); // unpublished is not found
    expect((await go({ resourceId: randomUUID(), name: 'Nothing' })).statusCode).toBe(404);
    const strict = await go({
      resourceId: t2.resourceId,
      name: 'Strict Copy',
      adaptationMode: 'STRICT',
    });
    expect(strict.statusCode).toBe(422);
    expect(strict.json().code).toBe('knowledge_template_incompatible');
    expect(JSON.stringify(strict.json().errors ?? strict.json())).toContain('mode_needs_starter');
    const pin = await go({ resourceId: t1.resourceId, versionId: t2.versionId, name: 'Pinned' });
    expect(pin.statusCode).toBe(422);
    expect(JSON.stringify(pin.json())).toContain('pinned_version_unavailable');
    expect(pin.json().code).toBe('knowledge_template_incompatible');
    expect((await go({ resourceId: t1.resourceId, name: 'My Dashboard' })).statusCode).toBe(409); // name taken: the project is the customer's, nothing was recorded
    const leak = await go({ resourceId: leaky.resourceId, name: 'Leaky Copy' });
    expect(leak.statusCode).toBe(422);
    expect(leak.json().code).toBe('change_rejected');
    expect((await go({ resourceId: missing.resourceId, name: 'Missing Copy' })).statusCode).toBe(
      422,
    );
    expect((await go({ resourceId: tampered.resourceId, name: 'Tampered Copy' })).statusCode).toBe(
      422,
    );
    for (const bad of [
      { name: 'x' },
      { resourceId: t1.resourceId },
      { resourceId: t1.resourceId, name: '' },
      { resourceId: t1.resourceId, name: 'y'.repeat(101) },
      { resourceId: t1.resourceId, name: 'z', adaptationMode: 'WILD' },
      { resourceId: t1.resourceId, name: 'z', versionId: 'nope' },
      { resourceId: t1.resourceId, name: 'z', planId: 'nope' },
    ])
      expect((await go(bad)).statusCode, JSON.stringify(bad)).toBe(422);
    expect(await projectCount(A())).toBe(before.projects);
    expect(await events(A(), 'COPIED')).toBe(before.copied);
  });

  it('generation plans record the requirement and the selection for a project; executing them is blocked; they are isolated per organization', async () => {
    const pj = (
      await e.sql(`SELECT id FROM builder.projects WHERE org_id = $1 AND name = 'My Dashboard'`, [
        A(),
      ])
    )[0]!.id as string;
    const bobPj = (
      await e.sql(`SELECT id FROM builder.projects WHERE org_id = $1 LIMIT 1`, [B()])
    )[0]!.id as string;
    const post = (who: string, org: string, body: Row) =>
      call(who, 'POST', '/v1/builder/generation-plans', body, org, idem());
    expect((await post('carol', A(), { projectId: pj, text: 'x' })).statusCode).toBe(403);
    expect((await post('alice', A(), { text: 'x' })).statusCode).toBe(422);
    expect((await post('alice', A(), { projectId: randomUUID(), text: 'x' })).statusCode).toBe(404);
    expect((await post('alice', A(), { projectId: bobPj, text: 'x' })).statusCode).toBe(404); // another organization's project
    const plan = ok<Row>(
      await post('alice', A(), {
        projectId: pj,
        text: 'لوحة تحكم لإدارة المبيعات',
        platform: 'WEB',
        mode: 'ADAPTIVE',
      }),
      201,
    );
    expect(plan).toMatchObject({
      projectId: pj,
      status: 'PLANNED',
      strategy: 'AUTO_SELECT',
      mode: 'ADAPTIVE',
    });
    expect(['Admin Dashboard Pro', 'Starter Dashboard']).toContain(
      ((plan.plan as Row).selected as Row).name,
    );
    expect(((plan.plan as Row).selected as Row).versionId).toBeTruthy();
    expect((plan.plan as Row).execution).toMatchObject({ status: 'BLOCKED' });
    expect(JSON.stringify(plan)).not.toMatch(/src\/|snapshots|Hidden Draft/);
    expect(
      ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${plan.id}`)),
    ).toMatchObject({ id: plan.id });
    expect(
      (await call('bob', 'GET', `/v1/builder/generation-plans/${plan.id}`, undefined, B()))
        .statusCode,
    ).toBe(404);
    expect((await call('alice', 'GET', '/v1/builder/generation-plans/not-an-id')).statusCode).toBe(
      404,
    );
    expect(
      e.sink.events.some((x) => x.action === 'knowledge.plan.created' && x.orgId === A()),
    ).toBe(true);
  });

  it('never executes or builds anything and calls no model: copying and planning are data operations', async () => {
    expect(
      (await e.sql(`SELECT count(*)::int n FROM ai.runs WHERE org_id = $1`, [A()]))[0]!.n,
    ).toBe(0);
  });
});

describe('adapting a copied template (S-K6)', () => {
  const MIT =
    'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
  const files = (tag: string) => [
    {
      path: 'package.json',
      content: JSON.stringify({
        name: tag,
        version: '1.0.0',
        dependencies: { next: '15.0.0', react: '19.0.0' },
      }),
    },
    { path: 'README.md', content: `# ${tag}\nTEMPLATE-README-${tag}\n` },
    { path: 'LICENSE', content: MIT },
    {
      path: 'src/app/page.tsx',
      content: `export default function Home() { return <main>TEMPLATE-PAGE-${tag}</main>; }\n`,
    },
    { path: 'src/lib/util.ts', content: `export const util = 'TEMPLATE-UTIL-${tag}';\n` },
  ];
  const A = () => e.org.A!;
  const B = () => e.org.B!;
  const call = (
    who: string,
    method: 'GET' | 'POST',
    url: string,
    body?: object,
    org = A(),
    extra: Record<string, string> = {},
  ) => e.call(who, method, url, body, org, { 'idempotency-key': randomUUID(), ...extra });
  const orgFlag = async (org: string, key: string, on: boolean | null) => {
    await e.sql(`DELETE FROM platform.feature_flags WHERE key = $1 AND org_id = $2`, [key, org]);
    if (on !== null)
      await e.sql(
        `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), $1, $2, $3::jsonb)`,
        [key, org, JSON.stringify(on)],
      );
  };
  const count = async (sqlText: string, args: unknown[]) =>
    Number((await e.sql(sqlText, args))[0]!.n);
  const runCount = (org: string) =>
    count(`SELECT count(*)::int n FROM ai.runs WHERE org_id = $1`, [org]);
  const usageCount = (org: string) =>
    count(`SELECT count(*)::int n FROM knowledge.usage_events WHERE org_id = $1`, [org]);
  let allowed: { resourceId: string; versionId: string };
  let withheld: { resourceId: string; versionId: string };
  let adapter: MockModelAdapter;
  let reply: (messages: { role: string; content: string }[]) => unknown = () => ({
    result: { summary: 'no change', patches: [] },
    toolCalls: [],
  });

  const copy = async (
    who: string,
    org: string,
    t: { resourceId: string },
    name: string,
    mode = 'ADAPTIVE',
  ) => {
    const r = ok<Row>(
      await call(
        who,
        'POST',
        '/v1/builder/projects/from-template',
        { resourceId: t.resourceId, name, adaptationMode: mode },
        org,
      ),
      201,
    );
    return (r.project as Row).id as string;
  };
  const plan = async (
    who: string,
    org: string,
    projectId: string,
    text: string,
    mode = 'ADAPTIVE',
  ) =>
    ok<Row>(
      await call(
        who,
        'POST',
        '/v1/builder/generation-plans',
        { projectId, text, platform: 'WEB', mode },
        org,
      ),
      201,
    ).id as string;
  const head = async (projectId: string) =>
    (await e.sql(`SELECT head_version_id FROM builder.projects WHERE id = $1`, [projectId]))[0]!
      .head_version_id as string;
  const change = async (who: string, org: string, projectId: string, patches: object[]) =>
    call(
      who,
      'POST',
      `/v1/builder/projects/${projectId}/changes`,
      { baseVersion: await head(projectId), patches, source: 'user' },
      org,
    );
  const filesOf = async (org: string, projectId: string) =>
    (await e.app.get<ProjectsPort>(ProjectsPort).readFiles(org, projectId, await head(projectId)))!;
  const drive = async (org: string, runId: string) => {
    const r = (await e.sql(`SELECT operation_id FROM ai.runs WHERE id = $1`, [runId]))[0]!;
    await e.app.get(RunService).runOne(org, r.operation_id as string);
    return (await e.sql(`SELECT state, error, result FROM ai.runs WHERE id = $1`, [runId]))[0]!;
  };
  const promptOf = () =>
    adapter.calls
      .at(-1)!
      .req.messages.map((m) => m.content)
      .join('\n');

  beforeAll(async () => {
    for (const org of [A(), B()]) {
      await orgFlag(org, 'knowledge.customer_templates', true);
      await orgFlag(org, 'app_builder.enabled', true);
      await orgFlag(org, 'knowledge.generation', null);
      await e.fund(org, '10000000');
    }
    adapter = new MockModelAdapter({
      id: 'mock-model',
      handler: (req) => JSON.stringify(reply(req.messages as { role: string; content: string }[])),
    });
    await e.enableMock('mock-model', { adapter });
    allowed = await item({ name: 'Adapt Allowed', ai: true, files: files('ALLOWED') });
    withheld = await item({ name: 'Adapt Withheld', ai: false, files: files('WITHHELD') });
  }, 300_000);

  it('is OFF by default and per organization: workspace, context and run answer 404; the plan says why it cannot run', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Off');
    const pl = await plan('alice', A(), pj, 'a dashboard');
    for (const [m, u] of [
      ['GET', `/v1/builder/projects/${pj}/template-workspace`],
      ['GET', `/v1/builder/generation-plans/${pl}/context`],
      ['POST', `/v1/builder/generation-plans/${pl}/runs`],
    ] as const)
      expect((await call('alice', m, u)).statusCode, u).toBe(404);
    const p = ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl}`));
    expect((p.plan as Row).execution).toMatchObject({ status: 'BLOCKED' });
    await orgFlag(A(), 'knowledge.generation', true);
    expect(
      (await call('alice', 'GET', `/v1/builder/projects/${pj}/template-workspace`)).statusCode,
    ).toBe(200);
    expect(
      (
        (ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl}`)).plan as Row)
          .execution as Row
      ).status,
    ).toBe('READY');
    const pjB = await copy('bob', B(), allowed, 'Gen Off B');
    expect(
      (await call('bob', 'GET', `/v1/builder/projects/${pjB}/template-workspace`, undefined, B()))
        .statusCode,
    ).toBe(404); // another organization is still off
  });

  it('the workspace is compared with what the copy wrote, and keeps working after the template is withdrawn', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Workspace');
    const w0 = ok<Row>(await call('alice', 'GET', `/v1/builder/projects/${pj}/template-workspace`));
    expect(w0).toMatchObject({
      linked: true,
      templateAvailable: true,
      template: { name: 'Adapt Allowed', license: 'MIT' },
    });
    expect(w0.diff).toMatchObject({
      added: [],
      modified: [],
      removed: [],
      unchanged: 5,
      baselineFiles: 5,
      currentFiles: 5,
      departure: 0,
    });
    ok(
      await change('alice', A(), pj, [
        {
          op: 'modify',
          path: 'src/app/page.tsx',
          content: 'export default function Home() { return <main>MINE</main>; }\n',
        },
        { op: 'add', path: 'src/mine.ts', content: 'export const mine = 1;\n' },
        { op: 'delete', path: 'README.md' },
      ]),
      200,
    );
    const w1 = ok<Row>(await call('carol', 'GET', `/v1/builder/projects/${pj}/template-workspace`))
      .diff as Row; // a viewer may read
    expect(w1).toMatchObject({
      added: ['src/mine.ts'],
      modified: ['src/app/page.tsx'],
      removed: ['README.md'],
      unchanged: 3,
      departure: 40,
      counts: { added: 1, modified: 1, removed: 1 },
    });
    await e.sql(`UPDATE knowledge.resources SET status = 'DISABLED' WHERE id = $1`, [
      allowed.resourceId,
    ]);
    const w2 = ok<Row>(await call('alice', 'GET', `/v1/builder/projects/${pj}/template-workspace`));
    expect(w2).toMatchObject({ linked: true, templateAvailable: false, template: null });
    expect(w2.diff).toEqual(w1);
    await e.sql(`UPDATE knowledge.resources SET status = 'ACTIVE' WHERE id = $1`, [
      allowed.resourceId,
    ]);
    // nothing of the template's files is in the answer, and another organization cannot see this project
    expect(JSON.stringify(w0)).not.toMatch(/TEMPLATE-|snapshots|objectKey/);
    expect(
      (await call('bob', 'GET', `/v1/builder/projects/${pj}/template-workspace`, undefined, B()))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('alice', 'GET', '/v1/builder/projects/not-an-id/template-workspace')).statusCode,
    ).toBe(404);
  });

  it('a project that was not copied from a template says so', async () => {
    const pr = await call('alice', 'POST', '/v1/builder/projects', {
      name: 'Plain Webapp',
      type: 'webapp',
    });
    const id = ok<Row>(pr, 201).id as string;
    expect(
      ok<Row>(await call('alice', 'GET', `/v1/builder/projects/${id}/template-workspace`)),
    ).toMatchObject({ linked: false, project: { id } });
  });

  it('the context preview shows exactly what a model would receive, in priority order, and writes and sends nothing', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Context');
    ok(
      await change('alice', A(), pj, [
        { op: 'add', path: 'src/mine.ts', content: 'export const MY_OWN_WORK = 1;\n' },
        { op: 'add', path: 'src/big.ts', content: `export const big = '${'x'.repeat(8000)}';\n` },
      ]),
      200,
    );
    const pl = await plan('alice', A(), pj, 'لوحة تحكم للمبيعات');
    const runs0 = await runCount(A());
    const usage0 = await usageCount(A());
    const calls0 = adapter.calls.length;
    const c = ok<Row>(await call('carol', 'GET', `/v1/builder/generation-plans/${pl}/context`));
    expect(c).toMatchObject({
      planId: pl,
      projectId: pj,
      mode: 'ADAPTIVE',
      aiProcessing: true,
      template: { name: 'Adapt Allowed' },
    });
    const blocks = c.blocks as Row[];
    expect(blocks.map((b) => b.kind)).toEqual([
      'requirement',
      'template',
      'file_index',
      'file',
      'file',
      'file',
      'file',
      'file',
      'file',
      'file',
    ]);
    expect(blocks[0]!.text).toContain('لوحة تحكم للمبيعات');
    expect(
      blocks
        .slice(3, 5)
        .map((b) => b.text)
        .join('\n'),
    ).toContain('MY_OWN_WORK'); // the customer's own work comes first (two files), the template's after
    expect(
      blocks
        .slice(5)
        .map((b) => b.text)
        .join('\n'),
    ).not.toContain('MY_OWN_WORK');
    expect(String(c.policy)).toContain('ADAPTIVE');
    expect(c.included).toContain('src/app/page.tsx'); // the template permits AI processing: its files may be sent
    expect((c.tokens as Row).used as number).toBeLessThanOrEqual(
      (c.tokens as Row).budget as number,
    );
    // a small budget leaves files out and says so
    const tight = ok<Row>(
      await call('alice', 'GET', `/v1/builder/generation-plans/${pl}/context?budget=1000`),
    );
    expect((tight.excluded as Row[]).some((x) => x.reason === 'over_budget')).toBe(true);
    // nothing was written, nothing was sent
    expect(await runCount(A())).toBe(runs0);
    expect(await usageCount(A())).toBe(usage0);
    expect(adapter.calls.length).toBe(calls0);
    expect(
      (await call('bob', 'GET', `/v1/builder/generation-plans/${pl}/context`, undefined, B()))
        .statusCode,
    ).toBe(404);
  });

  it("a template that does not permit AI processing has its unchanged source withheld: only paths are sent, the customer's own work still is", async () => {
    const pj = await copy('alice', A(), withheld, 'Gen Withheld');
    ok(
      await change('alice', A(), pj, [
        { op: 'add', path: 'src/mine.ts', content: 'export const MY_OWN_WORK = 2;\n' },
      ]),
      200,
    );
    const pl = await plan('alice', A(), pj, 'a shop');
    const c = ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl}/context`));
    expect(c).toMatchObject({ aiProcessing: false });
    expect(c.included).toEqual(['src/mine.ts']);
    expect((c.excluded as Row[]).every((x) => x.reason === 'ai_processing_not_allowed')).toBe(true);
    expect(c.notes).toContain('template_contents_withheld');
    const text = (c.blocks as Row[]).map((b) => b.text).join('\n');
    expect(text).not.toContain('TEMPLATE-PAGE-WITHHELD');
    expect(text).toContain('src/app/page.tsx | '); // the path is sent, not the content
    // a withdrawn template cannot vouch for its permission: it is treated as not allowed, and the customer's own work is still eligible
    const pj2 = await copy('alice', A(), allowed, 'Gen Withdrawn');
    ok(
      await change('alice', A(), pj2, [
        { op: 'add', path: 'src/mine.ts', content: 'export const MINE = 1;\n' },
      ]),
      200,
    );
    const pl2 = await plan('alice', A(), pj2, 'x');
    await e.sql(`UPDATE knowledge.resources SET status = 'DISABLED' WHERE id = $1`, [
      allowed.resourceId,
    ]);
    const gone = ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl2}/context`));
    await e.sql(`UPDATE knowledge.resources SET status = 'ACTIVE' WHERE id = $1`, [
      allowed.resourceId,
    ]);
    expect(gone).toMatchObject({ aiProcessing: false, template: null });
    expect(gone.included).toEqual(['src/mine.ts']);
    expect((gone.blocks as Row[]).map((x) => x.kind)).not.toContain('template');
  });

  it('starts a run that makes ONE model call over the previewed context and commits the proposal on the AI branch, once', async () => {
    const pj = await copy('alice', A(), withheld, 'Gen Run');
    ok(
      await change('alice', A(), pj, [
        { op: 'add', path: 'src/mine.ts', content: 'export const MY_OWN_WORK = 3;\n' },
      ]),
      200,
    );
    const pl = await plan('alice', A(), pj, 'add a pricing page for my shop');
    const preview = ok<Row>(
      await call('alice', 'GET', `/v1/builder/generation-plans/${pl}/context`),
    );
    reply = () => ({
      result: {
        summary: 'Add a pricing page',
        patches: [
          {
            op: 'add',
            path: 'src/app/pricing/page.tsx',
            content: 'export default function Pricing() { return <main>Pricing</main>; }\n',
          },
          { op: 'modify', path: 'src/mine.ts', content: 'export const MY_OWN_WORK = 4;\n' },
        ],
      },
      toolCalls: [],
    });
    expect(
      (await call('carol', 'POST', `/v1/builder/generation-plans/${pl}/runs`)).statusCode,
    ).toBe(403);
    const calls0 = adapter.calls.length;
    const key = randomUUID();
    const r = ok<Row>(
      await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`, {}, A(), {
        'idempotency-key': key,
      }),
      201,
    );
    expect(r).toMatchObject({ status: 'RUNNING', plan: { execution: { status: 'RUNNING' } } });
    const runId = ((r.plan as Row).execution as Row).runId as string;
    expect(
      (await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`)).statusCode,
    ).toBe(409); // a plan starts once
    expect(
      (
        await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`, {}, A(), {
          'idempotency-key': key,
        })
      ).statusCode,
    ).toBe(201); // the same key replays
    expect(adapter.calls.length).toBe(calls0); // nothing is sent until the run is driven
    const done = await drive(A(), runId);
    expect(done.state).toBe('succeeded');
    expect(adapter.calls.length).toBe(calls0 + 1); // ONE call
    // the model received the policy, the requirement and the customer's work, and NOT the withheld template source
    const sent = promptOf();
    expect(sent).toContain('Adaptation mode ADAPTIVE');
    expect(sent).toContain('add a pricing page for my shop');
    expect(sent).toContain('MY_OWN_WORK = 3');
    expect(sent).not.toContain('TEMPLATE-PAGE-WITHHELD');
    expect(sent).toContain('UNTRUSTED DATA'); // inside the run engine's fenced data blocks
    // the proposal is applied through the safe pipeline: the project has the changes; the template's own files are untouched
    const fs = await filesOf(A(), pj);
    expect(fs.get('src/app/pricing/page.tsx')).toContain('Pricing');
    expect(fs.get('src/mine.ts')).toContain('MY_OWN_WORK = 4');
    expect(fs.get('src/app/page.tsx')).toContain('TEMPLATE-PAGE-WITHHELD');
    expect(
      Number(
        (
          await e.sql(
            `SELECT count(*)::int n FROM knowledge.resource_files WHERE version_id = $1`,
            [withheld.versionId],
          )
        )[0]!.n,
      ),
    ).toBe(5);
    expect((done.result as Row).outcome).toBe('adapted');
    expect((done.result as Row).branch).toBe('work/ai');
    // the plan follows its run, and the workspace shows what changed against the copy
    const after = ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl}`));
    expect(after).toMatchObject({
      status: 'COMPLETED',
      plan: { execution: { status: 'COMPLETED', runState: 'succeeded' } },
    });
    const w = ok<Row>(await call('alice', 'GET', `/v1/builder/projects/${pj}/template-workspace`))
      .diff as Row;
    expect(w).toMatchObject({ added: ['src/app/pricing/page.tsx', 'src/mine.ts'] });
    expect(
      e.sink.events.some((x) => x.action === 'knowledge.plan.run_started' && x.orgId === A()),
    ).toBe(true);
    // what was sent is what the preview showed (same included files)
    expect(preview.included).toEqual(['src/mine.ts']);
  });

  it('STRICT mode: a proposal that deletes a template file is sent back to the model, repaired once, and only the repaired change is applied', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Strict', 'STRICT');
    const pl = await plan('alice', A(), pj, 'tidy up', 'STRICT');
    let n = 0;
    reply = () =>
      ++n === 1
        ? {
            result: { summary: 'tidy', patches: [{ op: 'delete', path: 'src/lib/util.ts' }] },
            toolCalls: [],
          }
        : {
            result: {
              summary: 'tidy',
              patches: [{ op: 'add', path: 'NOTES.md', content: '# notes\n' }],
            },
            toolCalls: [],
          };
    const r = ok<Row>(
      await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`, {}),
      201,
    );
    const done = await drive(A(), ((r.plan as Row).execution as Row).runId as string);
    expect(done.state).toBe('succeeded');
    expect(n).toBe(2);
    expect(promptOf()).toMatch(/STRICT mode: src\/lib\/util\.ts is a template file/); // the repair message reached the model
    const fs = await filesOf(A(), pj);
    expect(fs.has('src/lib/util.ts')).toBe(true);
    expect(fs.get('NOTES.md')).toBe('# notes\n');
  });

  it('a proposal that never passes the checks fails the run and the plan, and the project is untouched', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Bad', 'STRICT');
    const pl = await plan('alice', A(), pj, 'x', 'STRICT');
    const v0 = await head(pj);
    reply = () => ({
      result: { summary: 'bad', patches: [{ op: 'delete', path: 'src/lib/util.ts' }] },
      toolCalls: [],
    });
    const r = ok<Row>(
      await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`, {}),
      201,
    );
    const done = await drive(A(), ((r.plan as Row).execution as Row).runId as string);
    expect(done.state).toBe('failed');
    expect(await head(pj)).toBe(v0);
    expect(ok<Row>(await call('alice', 'GET', `/v1/builder/generation-plans/${pl}`))).toMatchObject(
      { status: 'FAILED' },
    );
  });

  it('a secret or a platform path in the proposal is refused by the same checks as every change; nothing is applied', async () => {
    const pj = await copy('alice', A(), allowed, 'Gen Secret');
    const pl = await plan('alice', A(), pj, 'x');
    const v0 = await head(pj);
    const key = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    reply = () => ({
      result: {
        summary: 's',
        patches: [{ op: 'add', path: 'src/keys.ts', content: `export const k = \`${key}\nabc\`` }],
      },
      toolCalls: [],
    });
    const r = ok<Row>(
      await call('alice', 'POST', `/v1/builder/generation-plans/${pl}/runs`, {}),
      201,
    );
    const done = await drive(A(), ((r.plan as Row).execution as Row).runId as string);
    expect(done.state).toBe('failed');
    expect(await head(pj)).toBe(v0);
    const pj2 = await copy('alice', A(), allowed, 'Gen Path');
    const pl2 = await plan('alice', A(), pj2, 'x');
    reply = () => ({
      result: { summary: 's', patches: [{ op: 'add', path: '../outside.ts', content: 'x' }] },
      toolCalls: [],
    });
    const r2 = ok<Row>(
      await call('alice', 'POST', `/v1/builder/generation-plans/${pl2}/runs`, {}),
      201,
    );
    expect((await drive(A(), ((r2.plan as Row).execution as Row).runId as string)).state).toBe(
      'failed',
    );
  });

  it("a run made through the generic run endpoint cannot bypass the flag or reach another organization's plan", async () => {
    // B: flag off; its own plan, run created directly
    const pjB = await copy('bob', B(), allowed, 'Gen Direct B');
    const plB = await plan('bob', B(), pjB, 'x');
    const sid = ok<Row>(
      await call('bob', 'POST', '/v1/ai/sessions', { title: 'S', projectId: pjB }, B()),
      201,
    ).id as string;
    const calls0 = adapter.calls.length;
    const run = ok<Row>(
      await call(
        'bob',
        'POST',
        '/v1/ai/runs',
        { sessionId: sid, kind: 'webapp', projectId: pjB, input: { templatePlanId: plB } },
        B(),
      ),
      202,
    );
    expect((await drive(B(), run.id as string)).state).toBe('failed');
    expect(adapter.calls.length).toBe(calls0); // no model call
    // A: a plan id of another organization is not found
    const pjA = await copy('alice', A(), allowed, 'Gen Direct A');
    const sidA = ok<Row>(
      await call('alice', 'POST', '/v1/ai/sessions', { title: 'S', projectId: pjA }),
      201,
    ).id as string;
    const runA = ok<Row>(
      await call('alice', 'POST', '/v1/ai/runs', {
        sessionId: sidA,
        kind: 'webapp',
        projectId: pjA,
        input: { templatePlanId: plB },
      }),
      202,
    );
    expect((await drive(A(), runA.id as string)).state).toBe('failed');
    expect(adapter.calls.length).toBe(calls0);
    // malformed input
    expect(
      (
        await call('alice', 'POST', '/v1/ai/runs', {
          sessionId: sidA,
          kind: 'webapp',
          projectId: pjA,
          input: { templatePlanId: 'nope' },
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await call('alice', 'POST', '/v1/ai/runs', {
          sessionId: sidA,
          kind: 'webapp',
          projectId: pjA,
          input: { templatePlanId: plB, brief: { prompt: 'x' } },
        })
      ).statusCode,
    ).toBe(422);
  });
});
