import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupAiEnv, type AiEnv, type Row } from '../ai/testing/ai-harness';

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
  o: { proposal?: string; block?: number; warn?: number } = {},
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
      `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'1','{}'::jsonb)`,
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
