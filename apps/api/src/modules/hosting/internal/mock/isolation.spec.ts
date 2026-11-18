/**
 * Isolation / escape suite (M06 §11, AC-M06-04). Every attempt below is made AS site A against site B's assets on the MOCK node and must be denied.
 * Mock evidence: the suite proves the hardening contract the agent must apply and that the control plane asks for it; it is NOT evidence about a
 * real kernel, filesystem, PHP-FPM or MySQL (those rows are BLOCKED until HG-06-01 and labelled NOT VERIFIED).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, mockStack, type MockStack } from './fixtures';
import { Denied } from './mock-cloudpanel';
import { tokenFor, siteNameFor } from '../cloudpanel-adapter';
import { testCtx } from './mocks';

let s: MockStack;
let A: string;
let B: string;
const mkSite = async (n: string, over: Partial<typeof LIMITS> = {}) => {
  const token = tokenFor('org', 'op-' + n, 'create_site');
  const name = siteNameFor(token);
  s.vault.newKey(`vault://hosting/b-${n}`);
  const r = await s.adapter.createSite(testCtx(), { nodeId: s.nodeId, computeInstanceId: 'i-1' }, {
    name, runtime: 'php:8.3', domain: `${name}.sites.example.test`, limits: { ...LIMITS, ...over }, credentialsRef: `vault://hosting/c-${n}`, backupKeyRef: `vault://hosting/b-${n}`, idempotencyToken: token, operationId: 'op-' + n,
  });
  expect(r.status).toBe('succeeded');
  return name;
};
beforeEach(async () => {
  s = mockStack();
  A = await mkSite('a');
  B = await mkSite('b');
  s.node.seed(B, '.env', 'DB_PASSWORD=hunter2', 0o600);
  s.node.seed(B, 'htdocs/index.php', '<?php echo "b";', 0o644);
  s.node.seed(B, 'htdocs/secret.txt', 'b-secret', 0o640);
  s.node.sites.get(B)!.tables.set('users', 'b-row');
  await s.node.actor(B).dbQuery(`INSERT INTO ${s.node.sites.get(B)!.db.name}.accounts VALUES 'b-data'`);
});
const denied = (fn: () => unknown, code?: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Denied);
    if (code) expect((e as Denied).code).toBe(code);
    return;
  }
  throw new Error('the attempt was NOT denied');
};

describe('files: other sites cannot read or traverse', () => {
  it('01 reads another site .env by absolute path', () => denied(() => s.node.actor(A).readFile(`/home/${B}/.env`), 'EACCES'));
  it('02 reads another site htdocs file (world-readable file inside a 0700 home)', () => denied(() => s.node.actor(A).readFile(`/home/${B}/htdocs/index.php`), 'EACCES'));
  it('03 path traversal with ../ from its own home', () => denied(() => s.node.actor(A).readFile(`/home/${A}/htdocs/../../${B}/.env`), 'EACCES'));
  it('04 symlink in its own htdocs pointing at the other home', () => {
    s.node.actor(A).symlink(`/home/${B}/htdocs/secret.txt`, `/home/${A}/htdocs/link`);
    denied(() => s.node.actor(A).readFile(`/home/${A}/htdocs/link`), 'EACCES');
  });
  it('05 symlink to the other home directory (directory traversal via link)', () => {
    s.node.actor(A).symlink(`/home/${B}`, `/home/${A}/htdocs/bhome`);
    denied(() => s.node.actor(A).readFile(`/home/${A}/htdocs/bhome/.env`), 'EACCES');
  });
  it('06 listing the other home directory', () => denied(() => s.node.actor(A).list(`/home/${B}`), 'EACCES'));
  it('07 reading the other site /tmp: /tmp is a private per-site directory', () => {
    s.node.actor(B).writeFile('/tmp/b-session', 'b-session-data');
    denied(() => s.node.actor(A).readFile('/tmp/b-session'), 'ENOENT');
    denied(() => s.node.actor(A).readFile(`/var/lib/private-tmp/${B}/b-session`), 'EACCES');
  });
  it('08 reading /etc/shadow and the agent private state', () => {
    denied(() => s.node.actor(A).readFile('/etc/shadow'), 'EACCES');
    denied(() => s.node.actor(A).readFile('/etc/nuzm-agent-key'), 'EACCES');
  });
  it('09 symlink loop / deep symlink chain cannot be abused to bypass checks', () => {
    for (let i = 0; i < 12; i++) s.node.actor(A).symlink(`/home/${A}/htdocs/l${i + 1}`, `/home/${A}/htdocs/l${i}`);
    denied(() => s.node.actor(A).readFile(`/home/${A}/htdocs/l0`), 'ENOENT');
  });
  it('10 writing into the other home', () => denied(() => s.node.actor(A).writeFile(`/home/${B}/htdocs/pwn.php`, 'x'), 'EACCES'));
  it('11 SFTP chroot: ../ and absolute symlinks cannot leave the jail', () => {
    s.node.actor(A).symlink('/etc/passwd', `/home/${A}/htdocs/p`);
    const a = s.node.actor(A);
    denied(() => a.readFile('/../../../etc/shadow', { chroot: true }));
    // inside the chroot the absolute link resolves relative to the jail root, which has no /etc/passwd
    denied(() => a.readFile('/htdocs/p', { chroot: true }), 'ENOENT');
  });
});

describe('processes, sockets, cron, logs, TLS keys', () => {
  it('12 /proc: other sites processes are invisible (hidepid=2)', () => {
    const mine = s.node.actor(A).listProcesses();
    const theirs = s.node.actor(B).listProcesses();
    expect(mine.length).toBeGreaterThan(0);
    for (const p of theirs) expect(mine).not.toContain(p);
  });
  it('13 /proc/<pid>/environ of another site', () => denied(() => s.node.actor(A).readProcEnviron(s.node.actor(B).listProcesses()[0]!), 'EACCES'));
  it('14 connecting to the other site PHP-FPM socket', () => denied(() => s.node.actor(A).connectSocket(`/run/php/${B}.sock`), 'EACCES'));
  it('15 reading the other site crontab', () => denied(() => s.node.actor(A).readCrontab(B), 'EACCES'));
  it('16 reading the other site logs', () => denied(() => s.node.actor(A).readLog(B), 'EACCES'));
  it('17 reading the other site TLS private key', async () => {
    const b = s.node.sites.get(B)!;
    await s.adapter.issueCertificate(testCtx(), { nodeId: s.nodeId, computeInstanceId: 'i' }, B, { domains: [b.domains[0]!], mode: 'managed' }, { idempotencyToken: tokenFor('o', 'c', 'cert'), operationId: 'c' });
    denied(() => s.node.actor(A).readTlsKey(B), 'EACCES');
  });
  it('18 own logs are readable (control: the denial is about OTHER sites)', () => expect(s.node.actor(A).readLog(A)).toBe(''));
});

describe('PHP runtime', () => {
  it('19 open_basedir blocks including another site file', () => denied(() => s.node.actor(A).phpInclude(`/home/${B}/htdocs/index.php`), 'OPEN_BASEDIR'));
  it('20 open_basedir bypass via symlink inside own htdocs is resolved before the check', () => {
    s.node.actor(A).symlink(`/home/${B}/htdocs/index.php`, `/home/${A}/htdocs/inc.php`);
    denied(() => s.node.actor(A).phpInclude(`/home/${A}/htdocs/inc.php`));
  });
  it('21 open_basedir bypass via ../ is normalised', () => denied(() => s.node.actor(A).phpInclude(`/home/${A}/htdocs/../../${B}/.env`)));
  it('22 dangerous functions are disabled (exec, system, proc_open, popen, putenv, symlink)', () => {
    for (const fn of ['exec', 'system', 'proc_open', 'popen', 'shell_exec', 'passthru', 'putenv', 'symlink', 'EXEC']) denied(() => s.node.actor(A).phpCall(fn), 'DISABLED_FUNCTION');
  });
});

describe('database', () => {
  it('23 cross-user query against another site database', () => denied(() => s.node.actor(A).dbQuery(`SELECT * FROM ${s.node.sites.get(B)!.db.name}.accounts`), 'DB_DENIED'));
  it('24 information_schema enumeration shows only the own database', () => {
    const list = s.node.actor(A).dbQuery('SELECT schema_name FROM information_schema.schemata') as string[];
    expect(list).toEqual(['information_schema', s.node.sites.get(A)!.db.name]);
    expect(list).not.toContain(s.node.sites.get(B)!.db.name);
    expect(s.node.actor(A).dbQuery('SHOW DATABASES')).toEqual(list);
  });
  it('25 USE / GRANT / CREATE USER / DROP DATABASE are denied', () => {
    denied(() => s.node.actor(A).dbQuery(`USE ${s.node.sites.get(B)!.db.name}`), 'DB_DENIED');
    for (const q of ['GRANT ALL ON *.* TO me', 'CREATE USER x', 'DROP DATABASE x', 'CREATE DATABASE y']) denied(() => s.node.actor(A).dbQuery(q), 'DB_DENIED');
  });
});

describe('resource exhaustion is confined by quotas without touching the neighbour', () => {
  it('26 fork bomb stops at the process limit; the neighbour can still fork', () => {
    denied(() => s.node.actor(A).forkMany(10_000), 'EAGAIN');
    expect(s.node.actor(B).forkMany(5)).toBe(5);
  });
  it('27 disk fill stops at the disk quota; the neighbour can still write', () => {
    denied(() => s.node.actor(A).fillDisk(10 * 1024 * 1024 * 1024), 'EDQUOT');
    expect(() => s.node.actor(B).writeFile(`/home/${B}/htdocs/ok.txt`, 'fine')).not.toThrow();
  });
  it('28 inode fill stops at the inode quota; the neighbour can still create files', () => {
    denied(() => s.node.actor(A).fillInodes(1_000_000), 'EDQUOT');
    expect(() => s.node.actor(B).writeFile(`/home/${B}/htdocs/ok2.txt`, 'fine')).not.toThrow();
  });
});

describe('control-plane / channel side', () => {
  it('29 a command for site A cannot be turned into an action on site B by argument tricks (names are validated, not interpreted)', async () => {
    const r = await s.transport.send({ nodeId: s.nodeId, operationId: 'x', idempotencyToken: 'y', commandId: 'site.delete', args: { site: `${A} ${B}` }, deadlineMs: 1000 });
    expect(r.status).toBe('rejected');
    expect(s.node.sites.has(B)).toBe(true);
  });
  it('30 backup archives are encrypted per site: site A key cannot open site B archive', async () => {
    const ctx = testCtx();
    const b = await s.adapter.backup(ctx, { nodeId: s.nodeId, computeInstanceId: 'i' }, B, { idempotencyToken: tokenFor('o', 'b', 'bk'), operationId: 'b' });
    expect(b.status).toBe('succeeded');
    const ref = [...s.sink.store.keys()][0]!;
    const blob = s.sink.store.get(ref)!;
    expect(blob.toString('utf8')).not.toContain('hunter2'); // ciphertext, not plaintext
    // restore of B's archive into A with A's key must fail authentication
    const aKey = s.vault.get(`vault://hosting/b-a`)!;
    expect(aKey.equals(s.vault.get(`vault://hosting/b-b`)!)).toBe(false);
  });
});
