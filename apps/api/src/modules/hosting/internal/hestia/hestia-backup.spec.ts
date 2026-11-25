import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemoryBackupSink, MemoryVault } from '../mock/mocks';
import type { BackupRef } from '../ports';
import { HestiaHostingAdapter, type ArchiveStager } from './adapter';
import { HestiaClient, HttpHestiaChannel } from './client';
import { startHestiaMock } from './mock-server';

const NODE = { nodeId: '00000000-0000-7000-8000-0000000000aa', computeInstanceId: 'i-1' };
const REGION = 'sa-central';
const NAME = 's-bbbb11112222cccc';
const ctx = {
  providerAccountId: 'p',
  credentialRef: 'vault://hosting/x',
  traceId: 't',
  deadlineMs: 2000,
};
const T = { idempotencyToken: 'a'.repeat(64), operationId: 'op-1' };
const LIMITS = { diskMb: 100, inodes: 5000, maxProcesses: 20, memoryMb: 256, bandwidthGbMonth: 10 };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A store whose `stat` can be made to show an archive still growing (an upload in progress). */
class GrowingSink extends MemoryBackupSink {
  growFor = 0;
  override async stat(ref: string) {
    const real = await super.stat(ref);
    if (real && this.growFor > 0) {
      this.growFor--;
      return { sizeBytes: real.sizeBytes - this.growFor - 1, sha256: real.sha256 };
    }
    return real;
  }
}

let mock: Awaited<ReturnType<typeof startHestiaMock>>;
let sink: GrowingSink;
let adapter: HestiaHostingAdapter;
let staged: string[];
beforeAll(async () => {
  mock = await startHestiaMock();
});
afterAll(() => mock.close());
beforeEach(async () => {
  mock.controls.users.clear();
  mock.controls.archives.clear();
  mock.controls.commands.length = 0;
  mock.controls.restores.length = 0;
  mock.controls.keepLocalCopy = true;
  mock.controls.backupHostConfigured = true;
  mock.controls.backupQueueRuns = true;
  sink = new GrowingSink();
  staged = [];
  mock.controls.onUpload = (user, name, data) =>
    void sink.store.set(`${REGION}/${user}/${name}`, data);
  const stager: ArchiveStager = {
    async stage(node, site, archive, ref) {
      const data = await sink.get(ref);
      if (!data) return { ok: false, detail: 'not in the store' };
      mock.controls.stage(site, archive, data);
      staged.push(archive);
      return { ok: true };
    },
  };
  const client = new HestiaClient(
    { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://x' }) },
    { accessKey: async () => mock.controls.hash },
    new HttpHestiaChannel({ allowPlainLoopback: true }),
  );
  adapter = new HestiaHostingAdapter(client, {
    vault: new MemoryVault(),
    evidenceKind: 'mock',
    packageFor: () => 'nuzm-starter',
    archives: { sink, regionOf: async () => REGION, waitMs: 1500, pollMs: 10 },
    stager,
  });
  const c = await adapter.createSite(ctx, NODE, {
    name: NAME,
    runtime: 'php:8.3',
    domain: 'shop.example.com',
    limits: LIMITS,
    credentialsRef: 'vault://c',
    backupKeyRef: 'vault://b',
    ...T,
  });
  expect(c.status).toBe('succeeded');
});

const take = async (over: Partial<Parameters<typeof adapter.backup>[3]> = {}) =>
  adapter.backup(ctx, NODE, NAME, { ...T, backupId: 'b1', ...over });

describe('probe', () => {
  it('offers backups only when the node proves a remote backup host; restores only with a stager', async () => {
    const on = await adapter.probe(ctx, NODE);
    expect(on.capabilities['hosting.backup.create']).toBe('supported');
    expect(on.capabilities['hosting.backup.restore']).toBe('supported');
    mock.controls.backupHostConfigured = false;
    const off = await adapter.probe(ctx, NODE);
    expect(off.capabilities['hosting.backup.create']).toBe('unsupported');
    expect(off.capabilities['hosting.backup.restore']).toBe('unsupported');
  });
});

describe('backup', () => {
  it('schedules once, finds the archive OFF the node and measures it there (size, sha256, snapshot of the account)', async () => {
    const r = await take();
    expect(r.status).toBe('succeeded');
    const d = r.data!;
    expect(d.archiveName).toMatch(new RegExp(`^${NAME}\\.2026-11-24_03-\\d\\d-\\d\\d\\.tar$`));
    expect(d.sinkRef).toBe(`${REGION}/${NAME}/${d.archiveName}`);
    expect(d.checksum).toBe(sha(sink.store.get(d.sinkRef!)!));
    expect(d.encrypted).toBe(false); // Hestia documents no encryption: the response says so
    expect(d.snapshot).toEqual({ domains: ['shop.example.com'], databases: 0 });
    expect(mock.controls.commands.filter((c) => c === 'v-schedule-user-backup')).toHaveLength(1);
  });

  it('a lost answer to the schedule is settled by a retry that only WAITS: one schedule, one archive', async () => {
    mock.controls.inject('v-schedule-user-backup', 'drop-after'); // the effect happened, the answer did not arrive
    const first = await take({ known: [], scheduleAllowed: true });
    expect(first.status).toBe('uncertain');
    const retry = await take({ known: [], scheduleAllowed: false });
    expect(retry.status).toBe('succeeded');
    expect(mock.controls.commands.filter((c) => c === 'v-schedule-user-backup')).toHaveLength(1);
    expect([...sink.store.keys()]).toHaveLength(1);
  });

  it('an archive that existed before is never mistaken for this backup', async () => {
    const one = (await take({ known: [], scheduleAllowed: true })).data!;
    const two = (await take({ backupId: 'b2', known: [one.archiveName!], scheduleAllowed: true }))
      .data!;
    expect(two.archiveName).not.toBe(one.archiveName);
    expect([...sink.store.keys()]).toHaveLength(2);
  });

  it('an archive still being uploaded (its size changes between looks) is not taken until it is stable', async () => {
    sink.growFor = 3;
    const r = await take({ known: [], scheduleAllowed: true });
    expect(r.status).toBe('succeeded');
    expect(r.data!.sizeBytes).toBe(sink.store.get(r.data!.sinkRef!)!.length);
  });

  it('a stuck queue is a retryable failure, not a success and not a second schedule', async () => {
    mock.controls.backupQueueRuns = false;
    const r = await adapter.backup(ctx, NODE, NAME, { ...T, known: [], scheduleAllowed: true });
    expect(r.status).toBe('failed');
    expect(r.error?.providerCode).toBe('archive_missing');
    expect(r.error?.category).toBe('provider_outage');
    expect(mock.controls.commands.filter((c) => c === 'v-schedule-user-backup')).toHaveLength(1);
  });

  it('an archive that is only on the node (not uploaded yet) is not a finished backup', async () => {
    mock.controls.onUpload = null; // the node never uploads
    const r = await adapter.backup(ctx, NODE, NAME, { ...T, known: [], scheduleAllowed: true });
    expect(r.status).toBe('failed');
    expect(r.error?.providerCode).toBe('archive_missing');
  });

  it('deleteBackup removes the node copy and treats an archive that is already gone as done', async () => {
    const d = (await take({ known: [], scheduleAllowed: true })).data!;
    expect((await adapter.deleteBackup(ctx, NODE, NAME, d.archiveName!)).status).toBe('succeeded');
    expect(mock.controls.archives.get(NAME)?.has(d.archiveName!)).toBe(false);
    expect((await adapter.deleteBackup(ctx, NODE, NAME, d.archiveName!)).status).toBe('succeeded');
  });
});

describe('restore', () => {
  const backupOf = async (): Promise<BackupRef> =>
    (await take({ known: [], scheduleAllowed: true })).data!;

  it('restores the account from its archive and proves it against the snapshot', async () => {
    const b = await backupOf();
    mock.controls.users.get(NAME)!.domains.clear(); // the customer lost the site
    const r = await adapter.restore(ctx, NODE, NAME, b, T);
    expect(r.status).toBe('succeeded');
    expect(r.data).toEqual({ verified: true, checksum: b.checksum });
    expect([...mock.controls.users.get(NAME)!.domains.keys()]).toEqual(['shop.example.com']);
    expect(mock.controls.restores).toEqual([{ user: NAME, backup: b.archiveName }]);
    expect(staged).toEqual([]); // the archive was still on the node
  });

  it('stages the archive on the node when only the off-server copy is left', async () => {
    mock.controls.keepLocalCopy = false;
    const b = await backupOf();
    mock.controls.users.get(NAME)!.domains.clear();
    const r = await adapter.restore(ctx, NODE, NAME, b, T);
    expect(r.status).toBe('succeeded');
    expect(staged).toEqual([b.archiveName]);
  });

  it('refuses a tampered archive BEFORE touching the node', async () => {
    const b = await backupOf();
    sink.store.set(b.sinkRef!, Buffer.from('tampered'));
    const r = await adapter.restore(ctx, NODE, NAME, b, T);
    expect(r.status).toBe('failed');
    expect(r.error?.category).toBe('validation');
    expect(mock.controls.restores).toEqual([]);
  });

  it('is unsupported when the archive is neither on the node nor stageable', async () => {
    mock.controls.keepLocalCopy = false;
    const b = await backupOf();
    const noStager = new HestiaHostingAdapter(
      new HestiaClient(
        { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://x' }) },
        { accessKey: async () => mock.controls.hash },
        new HttpHestiaChannel({ allowPlainLoopback: true }),
      ),
      {
        vault: new MemoryVault(),
        evidenceKind: 'mock',
        archives: { sink, regionOf: async () => REGION },
      },
    );
    const r = await noStager.restore(ctx, NODE, NAME, b, T);
    expect(r.error?.category).toBe('unsupported');
    expect(mock.controls.restores).toEqual([]);
  });

  it('a lost answer to v-restore-user is settled by comparing the account: the effect happened, so it is verified', async () => {
    const b = await backupOf();
    mock.controls.users.get(NAME)!.domains.clear();
    mock.controls.inject('v-restore-user', 'drop-after');
    const r = await adapter.restore(ctx, NODE, NAME, b, T);
    expect(r.status).toBe('succeeded');
  });

  it('a lost answer with NO effect is not reported as success', async () => {
    const b = await backupOf();
    mock.controls.users.get(NAME)!.domains.clear();
    mock.controls.inject('v-restore-user', 'drop');
    const r = await adapter.restore(ctx, NODE, NAME, b, T);
    expect(r.status).toBe('uncertain');
  });

  it('a panel error code is a failure, and a restore that leaves domains missing is unverified', async () => {
    const b = await backupOf();
    mock.controls.inject('v-restore-user', { code: 21 });
    expect((await adapter.restore(ctx, NODE, NAME, b, T)).error?.providerCode).toBe('E_BACKUP');
    // the snapshot says two domains, the account only has one after the "restore"
    const bigger = {
      ...b,
      snapshot: { domains: ['shop.example.com', 'gone.example.com'], databases: 0 },
    };
    const r = await adapter.restore(ctx, NODE, NAME, bigger, T);
    expect(r.status).toBe('failed');
    expect(r.error?.providerCode).toBe('restore_unverified');
  });
});
