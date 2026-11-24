import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemException } from '../../../../common/errors';
import { HestiaClient, HttpHestiaChannel } from '../hestia/client';
import { HESTIA_COMMANDS, HestiaArgError, buildArgs } from '../hestia/commands';
import { startHestiaMock } from '../hestia/mock-server';
import { LocalSftpSession } from '../mock/local-sftp';
import { checkCronSchedule, expandField } from './cron-schedule';
import { cleanRelative, guard, webRoot } from './path-guard';
import { loadToolsConfig } from './tools-config';

describe('cron schedule validation', () => {
  const f = (min: string, hour = '*', day = '*', month = '*', wday = '*') => ({
    min,
    hour,
    day,
    month,
    wday,
  });
  it('expands fields inside their ranges and refuses anything else', () => {
    expect([...expandField('*/15', [0, 59])!]).toEqual([0, 15, 30, 45]);
    expect([...expandField('1,5,10-12', [0, 59])!]).toEqual([1, 5, 10, 11, 12]);
    for (const bad of ['60', '*/0', '5-1', 'a', '', '1,,2', '0-70'])
      expect(expandField(bad, [0, 59]), bad).toBeNull();
  });
  it('accepts a daily job and refuses invalid or too frequent schedules (default: 5 minutes)', () => {
    expect(checkCronSchedule(f('0', '2'), 5)).toBeNull();
    expect(checkCronSchedule(f('*/5'), 5)).toBeNull();
    expect(checkCronSchedule(f('*/10', '*', '*', '*', '1-5'), 5)).toBeNull();
    expect(checkCronSchedule(f('*'), 5)).toBe('too_frequent');
    expect(checkCronSchedule(f('*/2'), 5)).toBe('too_frequent');
    expect(checkCronSchedule(f('0,3'), 5)).toBe('too_frequent');
    expect(checkCronSchedule(f('59', '1,2'), 5)).toBeNull(); // 59 then 59 an hour later
    expect(checkCronSchedule(f('0,58', '*'), 5)).toBe('too_frequent'); // 58 → 0 across the hour boundary
    expect(checkCronSchedule(f('61'), 5)).toBe('invalid_field');
    expect(checkCronSchedule(f('0', '24'), 5)).toBe('invalid_field');
    expect(checkCronSchedule(f('0', '2', '32'), 5)).toBe('invalid_field');
  });
});

describe('S05 command allow-list (documented argument order; every value is validated)', () => {
  const U = 's-abcdef123456';
  it('cron: v-add-cron-job USER MIN HOUR DAY MONTH WDAY CMD [JOB]; v-change-cron-job USER JOB MIN HOUR DAY MONTH WDAY CMD; v-delete-cron-job USER JOB', () => {
    const c = { min: '0', hour: '2', day: '*', month: '*', wday: '*', command: 'php /x/y.php' };
    expect(buildArgs(HESTIA_COMMANDS.addCronJob, { user: U, ...c, job: '3' })).toEqual([
      U,
      '0',
      '2',
      '*',
      '*',
      '*',
      'php /x/y.php',
      '3',
    ]);
    expect(buildArgs(HESTIA_COMMANDS.changeCronJob, { user: U, job: '3', ...c })).toEqual([
      U,
      '3',
      '0',
      '2',
      '*',
      '*',
      '*',
      'php /x/y.php',
    ]);
    expect(buildArgs(HESTIA_COMMANDS.deleteCronJob, { user: U, job: '3' })).toEqual([U, '3']);
    expect(HESTIA_COMMANDS.addCronJob.cmd).toBe('v-add-cron-job');
    expect(() => buildArgs(HESTIA_COMMANDS.addCronJob, { user: U, ...c, command: 'a\nb' })).toThrow(
      HestiaArgError,
    );
    expect(() => buildArgs(HESTIA_COMMANDS.addCronJob, { user: U, ...c, min: '$(id)' })).toThrow(
      HestiaArgError,
    );
    expect(() => buildArgs(HESTIA_COMMANDS.addCronJob, { user: 'root', ...c })).toThrow(
      HestiaArgError,
    );
  });
  it('logs: v-list-web-domain-accesslog USER DOMAIN LINES (plain)', () => {
    expect(
      buildArgs(HESTIA_COMMANDS.accessLog, { user: U, domain: 'a.example.com', lines: '50' }),
    ).toEqual([U, 'a.example.com', '50']);
    expect(() =>
      buildArgs(HESTIA_COMMANDS.errorLog, { user: U, domain: 'a.example.com', lines: '-1' }),
    ).toThrow(HestiaArgError);
    expect(() =>
      buildArgs(HESTIA_COMMANDS.errorLog, { user: U, domain: 'a.example.com; id', lines: '5' }),
    ).toThrow(HestiaArgError);
  });
  it('FTP and HTTP auth: the path never has .. and passwords are 12-64 characters', () => {
    const pw = 'correct-horse-9';
    expect(
      buildArgs(HESTIA_COMMANDS.addFtp, {
        user: U,
        domain: 'a.example.com',
        ftpUser: 'deploy',
        password: pw,
        path: '/public_html',
      }),
    ).toEqual([U, 'a.example.com', 'deploy', pw, '/public_html']);
    expect(() =>
      buildArgs(HESTIA_COMMANDS.addFtp, {
        user: U,
        domain: 'a.example.com',
        ftpUser: 'deploy',
        password: pw,
        path: '/../etc',
      }),
    ).toThrow(HestiaArgError);
    expect(() =>
      buildArgs(HESTIA_COMMANDS.addFtp, {
        user: U,
        domain: 'a.example.com',
        ftpUser: 'deploy',
        password: 'short',
      }),
    ).toThrow(HestiaArgError);
    expect(
      buildArgs(HESTIA_COMMANDS.addHttpAuth, {
        user: U,
        domain: 'a.example.com',
        authUser: 'staging',
        password: pw,
      }),
    ).toEqual([U, 'a.example.com', 'staging', pw]);
    expect(
      buildArgs(HESTIA_COMMANDS.deleteHttpAuth, {
        user: U,
        domain: 'a.example.com',
        authUser: 'staging',
      }),
    ).toEqual([U, 'a.example.com', 'staging']);
  });
  it('mail: v-add-mail-account USER DOMAIN ACCOUNT PASSWORD [QUOTA] and the alias commands', () => {
    const pw = 'correct-horse-9';
    expect(
      buildArgs(HESTIA_COMMANDS.addMailAccount, {
        user: U,
        domain: 'a.example.com',
        account: 'info',
        password: pw,
        quota: '500',
      }),
    ).toEqual([U, 'a.example.com', 'info', pw, '500']);
    expect(
      buildArgs(HESTIA_COMMANDS.addMailAlias, {
        user: U,
        domain: 'a.example.com',
        account: 'info',
        alias: 'sales',
      }),
    ).toEqual([U, 'a.example.com', 'info', 'sales']);
    expect(() =>
      buildArgs(HESTIA_COMMANDS.addMailAccount, {
        user: U,
        domain: 'a.example.com',
        account: 'Info@x',
        password: pw,
      }),
    ).toThrow(HestiaArgError);
    expect(HESTIA_COMMANDS.changeMailQuota.cmd).toBe('v-change-mail-account-quota');
    expect(HESTIA_COMMANDS.listMailAccounts.json).toBe(true);
  });
  it('every command of the allow-list names a documented v-* command (no free-form command exists)', () => {
    for (const d of Object.values(HESTIA_COMMANDS)) expect(d.cmd).toMatch(/^v-[a-z-]+$/);
  });
});

describe('the access-key profile of the runbook is exactly the allow-list', () => {
  it('docs/runbooks/node-onboarding.md lists every allow-listed command and nothing else', async () => {
    const md = await readFile(
      join(import.meta.dirname, '../../../../../../..', 'docs/runbooks/node-onboarding.md'),
      'utf8',
    );
    const listed = new Set(/COMMANDS='([^']*)'/.exec(md)![1]!.split(','));
    const allowed = new Set(Object.values(HESTIA_COMMANDS).map((d) => d.cmd));
    expect([...allowed].filter((c) => !listed.has(c))).toEqual([]);
    expect([...listed].filter((c) => !allowed.has(c))).toEqual([]);
  });
});

describe('plain-text reads (the logs) through the real client against the mock panel', () => {
  let mock: Awaited<ReturnType<typeof startHestiaMock>>;
  let client: HestiaClient;
  const U = 's-abcdef123456';
  beforeAll(async () => {
    mock = await startHestiaMock();
    client = new HestiaClient(
      { resolve: async () => ({ host: mock.host, port: mock.port, accessKeyRef: 'vault://x' }) },
      { accessKey: async () => mock.controls.hash },
      new HttpHestiaChannel({ allowPlainLoopback: true }),
    );
    mock.controls.users.set(U, {
      name: U,
      password: 'p',
      pkg: 'default',
      suspended: false,
      domains: new Map(),
      databases: new Map(),
      wpCli: false,
      cron: new Map(),
      mail: new Map(),
      sftpJail: false,
    });
    mock.controls.users.get(U)!.domains.set('a.example.com', {
      backend: 'default',
      ssl: false,
      notAfter: null,
      wp: { phase: 'none', placeholders: new Set(), posts: [] },
      ftp: new Map(),
      auth: new Set(),
      accessLog: ['l1', 'l2', 'l3', 'l4'],
      errorLog: [],
    });
  });
  afterAll(() => mock.close());
  it('returns the last N lines as text and an unknown domain as not_found', async () => {
    const r = await client.run(
      'n',
      'accessLog',
      { user: U, domain: 'a.example.com', lines: '2' },
      2000,
    );
    expect(r).toMatchObject({ ok: true, data: 'l3\nl4' });
    const none = await client.run(
      'n',
      'accessLog',
      { user: U, domain: 'b.example.com', lines: '2' },
      2000,
    );
    expect(none).toMatchObject({ ok: false, error: { category: 'not_found' } });
  });
});

describe('tools config', () => {
  it('defaults sell no mailboxes and cap an upload at the 64 MiB parser minus headroom', () => {
    const c = loadToolsConfig({});
    expect(c.defaults.mailboxes).toBe(0);
    expect(c.maxUploadMb).toBeLessThanOrEqual(60);
    expect(loadToolsConfig({ HOSTING_TOOLS_MAX_UPLOAD_MB: '500' }).maxUploadMb).toBe(60);
    expect(c.minCronIntervalMinutes).toBe(5);
  });
});

describe('path containment (real directory, real symbolic links)', () => {
  let base = '';
  let home = '';
  let root = '';
  let outside = '';
  let s: LocalSftpSession;
  const refused = async (p: Promise<unknown>, code = 'validation_failed') => {
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(ProblemException);
    expect((e as ProblemException).code).toBe(code);
  };
  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'nuzm-files-'));
    home = join(base, 'home', 's-abcdef123456');
    root = webRoot(home, 'a.example.com');
    outside = join(base, 'home', 's-other0000000');
    await mkdir(root, { recursive: true });
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'OTHER-CUSTOMER-DATA');
    await writeFile(join(root, 'index.php'), '<?php');
    await symlink(outside, join(root, 'escape')); // a link to ANOTHER ACCOUNT's home
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link'));
    await symlink('sub', join(root, 'inner-link')); // even a link that stays inside is refused: nothing is followed
    s = new LocalSftpSession(home);
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  it('cleanRelative: relative paths only; no .., no controls, no backslash, bounded', () => {
    expect(cleanRelative('')).toEqual([]);
    expect(cleanRelative('/')).toEqual([]);
    expect(cleanRelative('a//b/./c')).toEqual(['a', 'b', 'c']);
    for (const bad of [
      '..',
      'a/../b',
      '../etc/passwd',
      'a\\b',
      'a\0b',
      'a\nb',
      'x'.repeat(300),
      `${'a/'.repeat(600)}`,
    ])
      expect(() => cleanRelative(bad), JSON.stringify(bad).slice(0, 30)).toThrow(ProblemException);
  });
  it('resolves a normal file and a missing file below an existing folder', async () => {
    const a = await guard(s, home, root, 'index.php');
    expect(a.attrs?.type).toBe('file');
    const b = await guard(s, home, root, 'sub/new.txt');
    expect(b.attrs).toBeNull();
    expect((await guard(s, home, root, '')).attrs?.type).toBe('dir');
  });
  it('a missing parent is not_found, never created', async () => {
    await refused(guard(s, home, root, 'nope/new.txt'), 'not_found');
  });
  it('REFUSES a link to another account (read, write, deeper paths)', async () => {
    await refused(guard(s, home, root, 'escape'));
    await refused(guard(s, home, root, 'escape/secret.txt'));
    await refused(guard(s, home, root, 'escape/new.txt'));
    await refused(guard(s, home, root, 'secret-link'));
    await refused(guard(s, home, root, 'inner-link/x'));
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('OTHER-CUSTOMER-DATA');
  });
  it('the only link action allowed is addressing the link itself (to remove it)', async () => {
    const g = await guard(s, home, root, 'escape', { allowFinalLink: true });
    expect(g.attrs?.type).toBe('symlink');
    await refused(guard(s, home, root, 'escape/secret.txt', { allowFinalLink: true })); // never THROUGH it
  });
  it('the website folder itself cannot be the target of a change', async () => {
    await refused(guard(s, home, root, '', { notRoot: true }));
  });
  it('a website folder that is itself a link out of the account is refused', async () => {
    const h2 = join(base, 'home', 's-linkroot00000');
    await mkdir(join(h2, 'web', 'a.example.com'), { recursive: true });
    await symlink(outside, join(h2, 'web', 'a.example.com', 'public_html'));
    const s2 = new LocalSftpSession(h2);
    await refused(guard(s2, h2, webRoot(h2, 'a.example.com'), 'secret.txt'));
  });
  it('a missing website folder is not_found', async () => {
    await refused(guard(s, home, webRoot(home, 'nodomain.example.com'), ''), 'not_found');
  });
  it('the SFTP double refuses to open a link as a file and to overwrite an existing file (a hardened server does too)', async () => {
    await expect(s.read(join(root, 'secret-link'), 1000)).rejects.toThrow();
    await expect(s.writeNew(join(root, 'index.php'), Buffer.from('x'))).rejects.toThrow();
  });
});
