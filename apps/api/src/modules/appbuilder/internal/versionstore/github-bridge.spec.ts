import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeGitHostAdapter, GitHubAppAdapter } from '../studio/git-host';
import { GithubVersionBridge } from './github-bridge';
import { blobOid, sha1 } from './git-object';
import { MemoryVersionStore } from './memory-backend';

const mkRef = () => `${randomUUID()}/${randomUUID()}.git`;
const F = (o: Record<string, string>) => new Map(Object.entries(o));

/** A minimal GitHub REST Git Data API (SIMULATED: no network). Records every request so the tests can prove what the adapter calls. */
function fakeGitHubApi(initial: Record<string, string>) {
  type Tree = Map<string, string>; // path -> content
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const branches = new Map<string, string>();
  const blobs = new Map<string, string>();
  const requests: { method: string; url: string }[] = [];
  const addTree = (t: Tree) => {
    const sha = sha1(JSON.stringify([...t].sort()));
    trees.set(sha, t);
    for (const c of t.values()) blobs.set(blobOid(Buffer.from(c)), c);
    return sha;
  };
  const root = addTree(new Map(Object.entries(initial)));
  const c0 = sha1('c0');
  commits.set(c0, { tree: root, parents: [], message: 'init' });
  branches.set('main', c0);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ method, url: String(input) });
    const p = decodeURIComponent(url.pathname);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : {}; // eslint-disable-line @typescript-eslint/no-explicit-any -- test double
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(p))
      return json(201, {
        token: 'ghs_test',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    let m = /^\/repos\/o\/r$/.exec(p);
    if (m) return json(200, { id: 1, full_name: 'o/r', default_branch: 'main', private: true });
    m = /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(p);
    if (m)
      return branches.has(m[1]!)
        ? json(200, { object: { sha: branches.get(m[1]!) } })
        : json(404, {});
    m = /^\/repos\/o\/r\/git\/commits\/([0-9a-f]+)$/.exec(p);
    if (m)
      return commits.has(m[1]!)
        ? json(200, { sha: m[1], tree: { sha: commits.get(m[1]!)!.tree } })
        : json(404, {});
    if (p === '/repos/o/r/git/commits' && method === 'POST') {
      const sha = sha1(`${body.tree}${body.parents}${body.message}${commits.size}`);
      commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
      return json(201, { sha });
    }
    m = /^\/repos\/o\/r\/git\/trees\/([0-9a-f]+)$/.exec(p);
    if (m && method === 'GET') {
      const t = trees.get(m[1]!);
      if (!t) return json(404, {});
      return json(200, {
        truncated: false,
        tree: [...t].map(([path, c]) => ({
          path,
          type: 'blob',
          mode: '100644',
          sha: blobOid(Buffer.from(c)),
          size: c.length,
        })),
      });
    }
    if (p === '/repos/o/r/git/trees' && method === 'POST') {
      const next = new Map(trees.get(body.base_tree)!);
      for (const e of body.tree as { path: string; content?: string; sha?: null }[]) {
        if (e.sha === null) next.delete(e.path);
        else next.set(e.path, e.content!);
      }
      return json(201, { sha: addTree(next) });
    }
    m = /^\/repos\/o\/r\/git\/blobs\/([0-9a-f]+)$/.exec(p);
    if (m)
      return blobs.has(m[1]!)
        ? json(200, {
            content: Buffer.from(blobs.get(m[1]!)!).toString('base64'),
            encoding: 'base64',
          })
        : json(404, {});
    if (p === '/repos/o/r/git/refs' && method === 'POST') {
      branches.set(String(body.ref).replace('refs/heads/', ''), body.sha);
      return json(201, {});
    }
    m = /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/.exec(p);
    if (m && method === 'PATCH') {
      if (body.force) return json(422, {});
      branches.set(m[1]!, body.sha);
      return json(200, {});
    }
    return json(404, { message: `unhandled ${method} ${p}` });
  }) as typeof fetch;
  return { fetchImpl, requests, branches, commits, trees };
}

describe('GitHub bridge over the REAL GitHub App adapter and a simulated REST API', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const adapterFor = (api: ReturnType<typeof fakeGitHubApi>) =>
    new GitHubAppAdapter(
      { appId: '1', appSlug: 'nuzm-test', privateKeyPem: pem, webhookSecret: 'whsec-test' },
      api.fetchImpl,
    );

  it('exports a revision through blobs/trees/commits/refs only, never forces, and a retry does not push twice', async () => {
    const api = fakeGitHubApi({ 'a.txt': 'old\n', 'gone.txt': 'bye\n', 'same.txt': 's\n' });
    const store = new MemoryVersionStore();
    const bridge = new GithubVersionBridge(store, adapterFor(api));
    const ref = mkRef();
    await store.init(ref);
    const c = await store.commit(
      ref,
      'main',
      F({ 'a.txt': 'new\n', 'dir/b.txt': 'b\n', 'same.txt': 's\n' }),
      'v1',
    );
    const input = {
      ref,
      rev: 'main',
      installationId: 7,
      fullName: 'o/r',
      branch: 'nuzm/sync',
      message: 'Update from Nuzm',
    };
    const r = await bridge.exportToGitHub(input);
    expect(r).toMatchObject({
      pushed: true,
      commit: c.sha,
      changed: 2,
      deleted: 1,
      skippedBinary: [],
    });
    const remoteTip = api.branches.get('nuzm/sync')!;
    expect([...api.trees.get(api.commits.get(remoteTip)!.tree)!].sort()).toEqual([
      ['a.txt', 'new\n'],
      ['dir/b.txt', 'b\n'],
      ['same.txt', 's\n'],
    ]);
    expect(api.branches.get('main')).not.toBe(remoteTip); // main was not touched
    expect(await store.getRemoteRef(ref, 'github', 'nuzm-sync')).toBe(c.sha);
    const posts = api.requests.length;
    const again = await bridge.exportToGitHub(input);
    expect(again).toMatchObject({ pushed: false, reason: 'already_exported' });
    expect(api.requests.length).toBe(posts); // reconcile locally, no remote call at all
    // HTTPS to the API host only, Git Data API paths only
    for (const q of api.requests) {
      expect(q.url.startsWith('https://api.github.com/')).toBe(true);
      expect(new URL(q.url).pathname).toMatch(
        /^\/(app\/installations\/\d+\/access_tokens|repos\/o\/r(\/git\/(ref|refs|commits|trees|blobs)(\/.*)?)?)$/,
      );
    }
    expect(api.requests.some((q) => q.method === 'PATCH' || q.method === 'POST')).toBe(true);
  });

  it('skips binary files and reports them; pushes nothing when the remote already matches', async () => {
    const api = fakeGitHubApi({ 'a.txt': 'x\n' });
    const store = new MemoryVersionStore();
    const bridge = new GithubVersionBridge(store, adapterFor(api));
    const ref = mkRef();
    await store.init(ref);
    await store.commit(
      ref,
      'main',
      new Map<string, string | Uint8Array>([
        ['a.txt', 'x\n'],
        ['logo.png', Uint8Array.from([0, 1, 2])],
      ]),
      'v1',
    );
    const r = await bridge.exportToGitHub({
      ref,
      rev: 'main',
      installationId: 7,
      fullName: 'o/r',
      branch: 'main',
      message: 'm',
    });
    expect(r).toMatchObject({
      pushed: false,
      reason: 'nothing_to_push',
      skippedBinary: ['logo.png'],
    });
    expect(api.requests.some((q) => q.method === 'POST' && q.url.includes('/git/commits'))).toBe(
      false,
    );
  });

  it('imports a branch as a commit on an import branch (never on main) and re-importing the same state is idempotent', async () => {
    const api = fakeGitHubApi({ 'README.md': '# hi\n', 'src/x.ts': 'export {}\n' });
    const store = new MemoryVersionStore();
    const bridge = new GithubVersionBridge(store, adapterFor(api));
    const ref = mkRef();
    await store.init(ref);
    const mine = await store.commit(ref, 'main', F({ 'mine.txt': 'keep\n' }), 'mine');
    const first = await bridge.importFromGitHub({
      ref,
      installationId: 7,
      fullName: 'o/r',
      branch: 'main',
    });
    expect(first.commit.message).toMatch(/^Import o\/r@[0-9a-f]{7}$/);
    expect(Object.fromEntries(await store.readTree(ref, 'import/github-main'))).toEqual({
      'README.md': '# hi\n',
      'src/x.ts': 'export {}\n',
    });
    expect(await store.tipOf(ref, 'refs/heads/main')).toBe(mine.sha); // the project's own history is untouched
    expect(await store.getRemoteRef(ref, 'github', 'main')).toBe(first.commit.sha);
    const second = await bridge.importFromGitHub({
      ref,
      installationId: 7,
      fullName: 'o/r',
      branch: 'main',
    });
    expect(second.commit.sha).toBe(first.commit.sha);
    expect((await store.log(ref, 'import/github-main')).length).toBe(1);
  });

  it('refuses malformed repository or branch names before any request', async () => {
    const api = fakeGitHubApi({});
    const bridge = new GithubVersionBridge(new MemoryVersionStore(), adapterFor(api));
    const base = { ref: mkRef(), rev: 'main', installationId: 1, message: 'm' };
    await expect(
      bridge.exportToGitHub({ ...base, fullName: '../etc', branch: 'main' }),
    ).rejects.toMatchObject({ code: 'bad_ref' });
    await expect(
      bridge.exportToGitHub({ ...base, fullName: 'o/r', branch: 'Bad Branch' }),
    ).rejects.toMatchObject({ code: 'bad_ref' });
    expect(api.requests).toEqual([]);
  });
});

describe('GitHub bridge over the in-memory fake adapter', () => {
  it('a remote branch that moved is a conflict: nothing is recorded locally', async () => {
    const fake = new FakeGitHostAdapter();
    fake.addInstallation({
      id: 1,
      accountLogin: 'o',
      accountType: 'Organization',
      repositorySelection: 'all',
    });
    const repo = fake.addRepo(1, 'o/r', { 'a.txt': 'x\n' });
    const store = new MemoryVersionStore();
    const bridge = new GithubVersionBridge(store, fake);
    const ref = mkRef();
    await store.init(ref);
    await store.commit(ref, 'main', F({ 'a.txt': 'y\n' }), 'v1');
    // somebody pushes to the branch between our read and our commit
    const real = fake.commit.bind(fake);
    fake.commit = async (id, name, input) => {
      repo.branches.set(input.branch, 'f'.repeat(40));
      repo.commits.set('f'.repeat(40), new Map());
      return real(id, name, input);
    };
    repo.branches.set('feature', repo.branches.get('main')!);
    await expect(
      bridge.exportToGitHub({
        ref,
        rev: 'main',
        installationId: 1,
        fullName: 'o/r',
        branch: 'feature',
        message: 'm',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await store.getRemoteRef(ref, 'github', 'feature')).toBeNull();
  });
});
