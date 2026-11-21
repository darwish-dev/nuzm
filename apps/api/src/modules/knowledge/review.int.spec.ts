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

describe('retrieval and recommendation (S-K5)', () => {
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
    await analysed(s);
    ok<Row>(await review('padmin', s, 'approve'), 201);
    ok<Row>(await activate('padmin', s));
    const v = s.versionId;
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
      [v, JSON.stringify({ frameworks: o.frameworks ?? ['nextjs'] })],
    );
    if (o.architecture !== false) {
      await e.sql(
        `INSERT INTO knowledge.resource_manifests (id, version_id, org_id, schema_version, manifest) VALUES (gen_random_uuid(),$1,NULL,'2',$2::jsonb)`,
        [
          v,
          JSON.stringify({
            frameworks: o.frameworks ?? ['nextjs'],
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
      { text: 'x'.repeat(2001) },
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
