import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDatabase } from './checks';
import { loadManifest } from './migrations';
import { migrate } from './runner';

/**
 * S-K2a (SCR-K-02): the guarantees the database itself gives the ingestion pipeline, proved on a real PostgreSQL with the migration role AND the runtime roles.
 *  - the version state machine: only the documented edges, no jump to ACTIVE
 *  - the activation gate: ALLOWED licence (verdict + proposal), a completed analysis, no blocking finding, approvals from different people (two for
 *    third-party resources, neither the uploader), a rejection voids it, a new analysis voids earlier approvals
 *  - the ingestion worker: platform rows only, only its columns, never a licence verdict / review / activation, never a customer's rows
 *  - processing logs, scan findings and reviews are append-only; jobs cannot be rewritten once finished
 */
const admin = process.env.NUZM_TEST_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/postgres';
const manifest = loadManifest(join(__dirname, '../../../spec/db/ownership.yaml'));
const migrationsDir = join(__dirname, '../migrations');
const dbName = `nuzm_test_ing_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
const url = admin.replace(/\/[^/]*$/, `/${dbName}`);

const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const HASH = 'b'.repeat(64);
const ORG = id(900);
const UPLOADER = id(11);
const R1 = id(12);
const R2 = id(13);
const R3 = id(14);
const OK_CHECK = JSON.stringify({ findingsReviewed: true, licenseReviewed: true });

async function as<T>(
  role: string,
  gucs: Record<string, string>,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    for (const [k, v] of Object.entries(gucs))
      await c.query(`SELECT set_config($1, $2, true)`, [k, v]);
    const r = await fn(c);
    await c.query('ROLLBACK');
    return r;
  } finally {
    await c.end();
  }
}
const worker = { 'app.worker_scope': 'knowledge' };
const staff = { 'app.platform_scope': 'admin' };
async function root(q: string, p: unknown[] = []) {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(q, p)).rows;
  } finally {
    await c.end();
  }
}
const rootFails = async (q: string, p: unknown[] = []) => {
  try {
    await root(q, p);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};
const fails = async (role: string, gucs: Record<string, string>, q: string, p: unknown[] = []) => {
  try {
    await as(role, gucs, (c) => c.query(q, p));
  } catch (e) {
    return (e as Error).message;
  }
  return null;
};

let n = 1000;
/** A resource with one version already in `state`, plus an EXTRACT job that SUCCEEDED and is the version's analysis. */
async function fixture(
  opts: {
    state?: string;
    provenance?: 'FIRST_PARTY' | 'THIRD_PARTY';
    org?: string | null;
    verdict?: string;
    proposal?: string | null;
    analysed?: boolean;
  } = {},
) {
  const rid = id(n++);
  const vid = id(n++);
  const jid = id(n++);
  const org = opts.org ?? null;
  await root(
    `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, visibility, source_kind, status, data_region, provenance_class)
     VALUES ($1,$2,$3,$3,'THEME','WEB',$4,'upload','QUARANTINED','sa-central',$5)`,
    [
      rid,
      org,
      `r-${rid.slice(-6)}`,
      org ? 'TENANT_PRIVATE' : 'PLATFORM_PRIVATE',
      opts.provenance ?? 'THIRD_PARTY',
    ],
  );
  await root(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, license_verdict, created_by, license_proposal)
     VALUES ($1,$2,$3,1,'QUARANTINED',$4,10,$5,$6,$7,$8::jsonb)`,
    [
      vid,
      rid,
      org,
      HASH,
      `archives/${HASH}`,
      opts.verdict ?? 'ALLOWED',
      UPLOADER,
      opts.proposal === null ? null : JSON.stringify({ verdict: opts.proposal ?? 'ALLOWED' }),
    ],
  );
  if (opts.analysed !== false) {
    await root(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind, state) VALUES ($1,$2,$3,'EXTRACT','QUEUED')`,
      [jid, vid, org],
    );
    await root(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE id = $1`, [jid]);
    await root(`UPDATE knowledge.processing_jobs SET state = 'SUCCEEDED' WHERE id = $1`, [jid]);
    await root(`UPDATE knowledge.resource_versions SET analysis_job_id = $2 WHERE id = $1`, [
      vid,
      jid,
    ]);
  }
  for (const s of path(opts.state ?? 'AWAITING_REVIEW'))
    await root(`UPDATE knowledge.resource_versions SET state = $2 WHERE id = $1`, [vid, s]);
  return { rid, vid, jid, org };
}
const path = (to: string): string[] =>
  ({
    QUARANTINED: [],
    VALIDATING: ['VALIDATING'],
    ANALYZING: ['VALIDATING', 'ANALYZING'],
    AWAITING_REVIEW: ['VALIDATING', 'ANALYZING', 'AWAITING_REVIEW'],
  })[to] ?? [];
const review = (
  f: { rid: string; vid: string; jid: string; org: string | null },
  reviewer: string,
  decision = 'APPROVE',
  check = OK_CHECK,
  reason: string | null = null,
) =>
  root(
    `INSERT INTO knowledge.resource_reviews (id, version_id, resource_id, org_id, analysis_job_id, decision, reviewer_id, reason, checklist) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [id(n++), f.vid, f.rid, f.org, f.jid, decision, reviewer, reason, check],
  );
const activate = (vid: string) =>
  rootFails(
    `UPDATE knowledge.resource_versions SET state = 'ACTIVE', activated_by = $2 WHERE id = $1`,
    [vid, R1],
  );
const finding = (f: { vid: string; jid: string }, severity: string) =>
  root(
    `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, path, line, detail) VALUES ($1,$2,NULL,$3,'secrets','secret_found',$4,'a.ts',3,'aws_access_key at a.ts:3')`,
    [id(n++), f.vid, f.jid, severity],
  );

beforeAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`CREATE DATABASE "${dbName}"`);
  await c.end();
  await migrate({ url, migrationsDir, manifest });
});
afterAll(async () => {
  const c = new Client({ connectionString: admin });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await c.end();
});

describe('schema', () => {
  it('passes the ownership + RLS rules with the new tables', async () => {
    expect(await checkDatabase(url, manifest)).toEqual([]);
  });
});

describe('the version state machine', () => {
  const EDGES: [string, string[]][] = [
    ['QUARANTINED', ['VALIDATING', 'DISABLED', 'ARCHIVED']],
    ['VALIDATING', ['ANALYZING', 'QUARANTINED', 'FAILED']],
    ['ANALYZING', ['INDEXING', 'AWAITING_REVIEW', 'QUARANTINED', 'FAILED']],
  ];
  it.each(EDGES)('%s may only move to %j', async (from, allowed) => {
    const all = [
      'UPLOADING',
      'QUARANTINED',
      'VALIDATING',
      'ANALYZING',
      'INDEXING',
      'AWAITING_REVIEW',
      'ACTIVE',
      'FAILED',
      'DISABLED',
      'ARCHIVED',
    ];
    for (const to of all.filter((s) => s !== from)) {
      const f = await fixture({ state: from, provenance: 'FIRST_PARTY' });
      const err = await rootFails(
        `UPDATE knowledge.resource_versions SET state = $2 WHERE id = $1`,
        [f.vid, to],
      );
      if (allowed.includes(to)) expect(err, `${from} -> ${to}`).toBeNull();
      else expect(err, `${from} -> ${to}`).toMatch(/not allowed|activation|licen/i);
    }
  });
  it('QUARANTINED can never jump to ACTIVE, even with every other condition met', async () => {
    const f = await fixture({ state: 'QUARANTINED', provenance: 'FIRST_PARTY' });
    await review(f, R1).catch(() => undefined);
    expect(await activate(f.vid)).toMatch(/QUARANTINED -> ACTIVE is not allowed/);
  });
  it('ARCHIVED is terminal, FAILED may only be retried or archived', async () => {
    const f = await fixture({ state: 'ANALYZING' });
    await root(`UPDATE knowledge.resource_versions SET state = 'FAILED' WHERE id = $1`, [f.vid]);
    expect(
      await rootFails(
        `UPDATE knowledge.resource_versions SET state = 'AWAITING_REVIEW' WHERE id = $1`,
        [f.vid],
      ),
    ).toMatch(/not allowed/);
    await root(`UPDATE knowledge.resource_versions SET state = 'ARCHIVED' WHERE id = $1`, [f.vid]);
    expect(
      await rootFails(
        `UPDATE knowledge.resource_versions SET state = 'QUARANTINED' WHERE id = $1`,
        [f.vid],
      ),
    ).toMatch(/not allowed/);
  });
});

describe('the activation gate', () => {
  it('third-party: needs two approvals from different people, neither the uploader', async () => {
    const f = await fixture();
    expect(await activate(f.vid)).toMatch(/needs 2 approval/);
    await review(f, R1);
    expect(await activate(f.vid)).toMatch(/found 1/);
    // the same person twice does not count twice
    expect(await review(f, R1).catch((e: Error) => e.message)).toMatch(/duplicate|unique/i);
    expect(await activate(f.vid)).toMatch(/found 1/);
    await review(f, R2);
    expect(await activate(f.vid)).toBeNull();
    expect(
      (
        await root(`SELECT state, activated_at FROM knowledge.resource_versions WHERE id = $1`, [
          f.vid,
        ])
      )[0],
    ).toMatchObject({ state: 'ACTIVE' });
  });
  it('the uploader cannot review their own third-party upload, but may a first-party one', async () => {
    const t = await fixture();
    expect(await review(t, UPLOADER).catch((e: Error) => e.message)).toMatch(
      /uploader cannot review/,
    );
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await review(f, UPLOADER);
    expect(await activate(f.vid)).toBeNull();
  });
  it('first-party needs one approval', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    expect(await activate(f.vid)).toMatch(/needs 1 approval/);
    await review(f, R1);
    expect(await activate(f.vid)).toBeNull();
  });
  it('an approval confirms that findings and licence were reviewed', async () => {
    const f = await fixture();
    for (const c of [
      {},
      { findingsReviewed: true },
      { licenseReviewed: true },
      { findingsReviewed: false, licenseReviewed: true },
    ])
      expect(
        await review(f, R1, 'APPROVE', JSON.stringify(c)).catch((e: Error) => e.message),
      ).toMatch(/findings and the licence were reviewed/);
  });
  it('a licence that is not ALLOWED (verdict or proposal) blocks activation', async () => {
    for (const [verdict, proposal] of [
      ['UNKNOWN', 'ALLOWED'],
      ['ALLOWED', 'UNKNOWN'],
      ['ALLOWED', 'RESTRICTED'],
      ['ALLOWED', 'BLOCKED'],
      ['ALLOWED', null],
    ] as const) {
      const f = await fixture({ provenance: 'FIRST_PARTY', verdict, proposal });
      await review(f, R1);
      expect(await activate(f.vid), `${verdict}/${proposal}`).toMatch(/ALLOWED licence/);
    }
  });
  it('a version that was never analysed cannot be activated', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY', analysed: false });
    expect(await activate(f.vid)).toMatch(/completed analysis/);
  });
  it('a blocking finding blocks activation, a warning does not', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await review(f, R1);
    await finding(f, 'warn');
    await finding(f, 'info');
    await finding(f, 'block');
    expect(await activate(f.vid)).toMatch(/blocking scan findings/);
    const g = await fixture({ provenance: 'FIRST_PARTY' });
    await review(g, R1);
    await finding(g, 'warn');
    expect(await activate(g.vid)).toBeNull();
  });
  it('a rejection voids the analysis; a new analysis voids earlier approvals', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await review(f, R1);
    await review(f, R2, 'REJECT', '{}', 'The licence file is not the one the seller supplied.');
    expect(await activate(f.vid)).toMatch(/rejected analysis/);
    // a new analysis: approvals were for the old job
    const g = await fixture({ provenance: 'FIRST_PARTY' });
    await review(g, R1);
    const jid2 = id(n++);
    await root(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind, state) VALUES ($1,$2,NULL,'EXTRACT','QUEUED')`,
      [jid2, g.vid],
    );
    await root(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE id = $1`, [jid2]);
    await root(`UPDATE knowledge.processing_jobs SET state = 'SUCCEEDED' WHERE id = $1`, [jid2]);
    await root(`UPDATE knowledge.resource_versions SET analysis_job_id = $2 WHERE id = $1`, [
      g.vid,
      jid2,
    ]);
    expect(await activate(g.vid)).toMatch(/needs 1 approval/);
  });
  it('a rejection needs a reason', async () => {
    const f = await fixture();
    expect(await review(f, R1, 'REJECT', '{}', 'no').catch((e: Error) => e.message)).toMatch(
      /check/i,
    );
  });
  it('only the current analysis of a version AWAITING_REVIEW can be reviewed', async () => {
    const f = await fixture({ state: 'ANALYZING' });
    expect(await review(f, R1).catch((e: Error) => e.message)).toMatch(/awaiting review/);
    const g = await fixture();
    const stale = { ...g, jid: id(n++) };
    expect(await review(stale, R1).catch((e: Error) => e.message)).toMatch(/current analysis/);
  });
  it('re-enabling a DISABLED version goes through the same gate', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await review(f, R1);
    expect(await activate(f.vid)).toBeNull();
    await root(`UPDATE knowledge.resource_versions SET state = 'DISABLED' WHERE id = $1`, [f.vid]);
    await root(
      `UPDATE knowledge.resource_versions SET license_verdict = 'RESTRICTED' WHERE id = $1`,
      [f.vid],
    );
    expect(await activate(f.vid)).toMatch(/ALLOWED licence/);
  });
  it('the provenance class cannot be loosened after the fact', async () => {
    const f = await fixture();
    expect(
      await rootFails(
        `UPDATE knowledge.resources SET provenance_class = 'FIRST_PARTY' WHERE id = $1`,
        [f.rid],
      ),
    ).toMatch(/immutable/);
  });
  it('the runtime role cannot skip the gate either (fail closed outside the platform scope)', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await review(f, R1);
    expect(
      await fails(
        'nuzm_app',
        staff,
        `UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE id = $1`,
        [f.vid],
      ),
    ).toBeNull(); // allowed: gate satisfied
    const g = await fixture({ provenance: 'FIRST_PARTY' });
    await review(g, R1);
    // no scope: RLS hides the version, nothing is updated
    expect(
      await as(
        'nuzm_app',
        {},
        async (c) =>
          (
            await c.query(`UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE id = $1`, [
              g.vid,
            ])
          ).rowCount,
      ),
    ).toBe(0);
  });
});

describe('processing jobs', () => {
  it('allow only the documented transitions and are frozen once finished', async () => {
    const f = await fixture({ analysed: false, state: 'QUARANTINED' });
    const j = id(n++);
    await root(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
      [j, f.vid],
    );
    expect(
      await rootFails(`UPDATE knowledge.processing_jobs SET state = 'SUCCEEDED' WHERE id = $1`, [
        j,
      ]),
    ).toMatch(/QUEUED -> SUCCEEDED/);
    await root(
      `UPDATE knowledge.processing_jobs SET state = 'RUNNING', attempt = 1 WHERE id = $1`,
      [j],
    );
    await root(`UPDATE knowledge.processing_jobs SET state = 'QUEUED' WHERE id = $1`, [j]); // lease expired: requeued
    await root(`UPDATE knowledge.processing_jobs SET state = 'RUNNING' WHERE id = $1`, [j]);
    await root(
      `UPDATE knowledge.processing_jobs SET state = 'FAILED', error_code = 'ratio_exceeded' WHERE id = $1`,
      [j],
    );
    expect(
      await rootFails(`UPDATE knowledge.processing_jobs SET state = 'QUEUED' WHERE id = $1`, [j]),
    ).toMatch(/not allowed|finished/);
    expect(await rootFails(`DELETE FROM knowledge.processing_jobs WHERE id = $1`, [j])).toMatch(
      /never deleted/,
    );
    expect(
      await rootFails(`UPDATE knowledge.processing_jobs SET kind = 'EXTRACT' WHERE id = $1`, [j]),
    ).toMatch(/immutable|finished/);
  });
  it('allow one active job per version and kind', async () => {
    const f = await fixture({ analysed: false, state: 'QUARANTINED' });
    await root(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
      [id(n++), f.vid],
    );
    expect(
      await rootFails(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
        [id(n++), f.vid],
      ),
    ).toMatch(/duplicate|unique/);
    await root(
      `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'EXTRACT')`,
      [id(n++), f.vid],
    );
  });
});

describe('the ingestion worker', () => {
  it('sees platform rows only under its scope, and nothing without it', async () => {
    const p = await fixture({ state: 'QUARANTINED' });
    const t = await fixture({ state: 'QUARANTINED', org: ORG });
    const sees = (guc: Record<string, string>, table: string) =>
      as('nuzm_worker', guc, async (c) =>
        (await c.query(`SELECT id FROM knowledge.${table}`)).rows.map((r) => r.id as string),
      );
    for (const table of ['resources', 'resource_versions', 'processing_jobs']) {
      expect(await sees({}, table)).toEqual([]);
      expect(
        await sees({ 'app.worker_scope': 'claim' }, table),
        'the generic claim scope must not open knowledge rows',
      ).toEqual([]);
      const rows = await sees(worker, table);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).not.toContain(t.rid);
      expect(rows).not.toContain(t.vid);
      expect(rows).not.toContain(t.jid);
    }
    expect(await sees(worker, 'resource_versions')).toContain(p.vid);
  });
  it('can write its own columns on platform rows', async () => {
    const f = await fixture({ analysed: false, state: 'QUARANTINED' });
    await as('nuzm_worker', worker, async (c) => {
      const j = id(n++);
      await c.query(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'VALIDATE')`,
        [j, f.vid],
      );
      await c.query(
        `UPDATE knowledge.processing_jobs SET state='RUNNING', lease_owner='w1', lease_expires_at = now() + interval '5 min', attempt = 1 WHERE id=$1`,
        [j],
      );
      expect(
        (
          await c.query(
            `UPDATE knowledge.resource_versions SET state='VALIDATING', state_reason = NULL, ingest_summary = '{"a":1}'::jsonb WHERE id=$1`,
            [f.vid],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (await c.query(`UPDATE knowledge.resources SET status='VALIDATING' WHERE id=$1`, [f.rid]))
          .rowCount,
      ).toBe(1);
      await c.query(
        `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES ($1,$2,$3,NULL,'info','VALIDATE','started','validation started')`,
        [id(n++), j, f.vid],
      );
      await c.query(
        `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, detail) VALUES ($1,$2,NULL,$3,'license','license_unknown','warn','no licence')`,
        [id(n++), f.vid, j],
      );
      await c.query(
        `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes) VALUES ($1,$2,NULL,'a.ts',$3,3)`,
        [id(n++), f.vid, HASH],
      );
      await c.query(
        `INSERT INTO knowledge.resource_dependencies (id, version_id, org_id, ecosystem, name) VALUES ($1,$2,NULL,'npm','next')`,
        [id(n++), f.vid],
      );
    });
  });
  it('can never set a licence verdict, activate, review, change identity columns, or write a tenant row', async () => {
    const f = await fixture({ analysed: false, state: 'QUARANTINED' });
    const t = await fixture({ analysed: false, state: 'QUARANTINED', org: ORG });
    const w = (q: string, p: unknown[] = []) => fails('nuzm_worker', worker, q, p);
    expect(
      await w(`UPDATE knowledge.resource_versions SET license_verdict = 'ALLOWED' WHERE id = $1`, [
        f.vid,
      ]),
    ).toMatch(/permission denied/);
    expect(
      await w(`UPDATE knowledge.resource_versions SET activated_by = $2 WHERE id = $1`, [
        f.vid,
        R1,
      ]),
    ).toMatch(/permission denied/);
    expect(
      await w(`UPDATE knowledge.resource_versions SET archive_key = 'x' WHERE id = $1`, [f.vid]),
    ).toMatch(/permission denied/);
    expect(
      await w(`UPDATE knowledge.resources SET provenance_class = 'FIRST_PARTY' WHERE id = $1`, [
        f.rid,
      ]),
    ).toMatch(/permission denied/);
    expect(
      await w(`UPDATE knowledge.resources SET visibility = 'PLATFORM_PUBLISHED' WHERE id = $1`, [
        f.rid,
      ]),
    ).toMatch(/permission denied/);
    expect(
      await w(
        `INSERT INTO knowledge.resource_reviews (id, version_id, resource_id, org_id, analysis_job_id, decision, reviewer_id) VALUES ($1,$2,$3,NULL,$4,'APPROVE',$5)`,
        [id(n++), f.vid, f.rid, id(1), R1],
      ),
    ).toMatch(/permission denied/);
    expect(
      await w(`UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE id = $1`, [f.vid]),
    ).toMatch(/not allowed|activation/);
    expect(await w(`DELETE FROM knowledge.resource_versions WHERE id = $1`, [f.vid])).toMatch(
      /permission denied/,
    );
    // a tenant's version is invisible to it: the UPDATE touches nothing, an INSERT for a tenant row is refused by the policy
    expect(
      await as(
        'nuzm_worker',
        worker,
        async (c) =>
          (
            await c.query(
              `UPDATE knowledge.resource_versions SET state = 'VALIDATING' WHERE id = $1`,
              [t.vid],
            )
          ).rowCount,
      ),
    ).toBe(0);
    expect(
      await w(
        `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES ($1,$2,$3,$4,'info','VALIDATE','x','x')`,
        [id(n++), id(1), t.vid, ORG],
      ),
    ).toMatch(/row-level security/);
    expect(
      await w(
        `INSERT INTO knowledge.resource_files (id, version_id, org_id, path, sha256, bytes) VALUES ($1,$2,$3,'a',$4,1)`,
        [id(n++), t.vid, ORG, HASH],
      ),
    ).toMatch(/row-level security/);
  });
});

describe('evidence is append-only and tenants cannot read platform evidence', () => {
  it('logs, findings and reviews cannot be changed or deleted, even by the migration role', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await finding(f, 'warn');
    await review(f, R1);
    await root(
      `INSERT INTO knowledge.processing_logs (id, job_id, version_id, org_id, level, stage, code, message) VALUES ($1,$2,$3,NULL,'info','EXTRACT','x','x')`,
      [id(n++), f.jid, f.vid],
    );
    for (const t of ['processing_logs', 'scan_findings', 'resource_reviews']) {
      expect(
        await rootFails(`UPDATE knowledge.${t} SET created_at = now() WHERE version_id = $1`, [
          f.vid,
        ]),
        t,
      ).toMatch(/append-only/);
      expect(
        await rootFails(`DELETE FROM knowledge.${t} WHERE version_id = $1`, [f.vid]),
        t,
      ).toMatch(/append-only/);
    }
  });
  it('a customer (org context) sees none of the platform logs, findings or reviews; staff see all', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    await finding(f, 'warn');
    await review(f, R1);
    for (const t of ['processing_logs', 'scan_findings', 'resource_reviews', 'processing_jobs']) {
      expect(
        await as(
          'nuzm_app',
          { 'app.org_id': id(901) },
          async (c) => (await c.query(`SELECT 1 FROM knowledge.${t}`)).rowCount,
        ),
        t,
      ).toBe(0);
    }
    expect(
      await as(
        'nuzm_app',
        staff,
        async (c) =>
          (await c.query(`SELECT 1 FROM knowledge.scan_findings WHERE version_id = $1`, [f.vid]))
            .rowCount,
      ),
    ).toBe(1);
    expect(
      await fails(
        'nuzm_app',
        staff,
        `UPDATE knowledge.scan_findings SET severity = 'info' WHERE version_id = $1`,
        [f.vid],
      ),
    ).toMatch(/permission denied/);
  });
  it('the app role cannot write findings (only the worker does) but can write reviews', async () => {
    const f = await fixture({ provenance: 'FIRST_PARTY' });
    expect(
      await fails(
        'nuzm_app',
        staff,
        `INSERT INTO knowledge.scan_findings (id, version_id, org_id, job_id, scanner, code, severity, detail) VALUES ($1,$2,NULL,$3,'secrets','x','info','x')`,
        [id(n++), f.vid, f.jid],
      ),
    ).toMatch(/permission denied/);
    await as('nuzm_app', staff, (c) =>
      c.query(
        `INSERT INTO knowledge.resource_reviews (id, version_id, resource_id, org_id, analysis_job_id, decision, reviewer_id, checklist) VALUES ($1,$2,$3,NULL,$4,'APPROVE',$5,$6::jsonb)`,
        [id(n++), f.vid, f.rid, f.jid, R3, OK_CHECK],
      ),
    );
  });
});
