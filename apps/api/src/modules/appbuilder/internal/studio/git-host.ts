import { createHmac, createSign, randomUUID, timingSafeEqual } from 'node:crypto';
import { ProblemException } from '../../../../common/errors';

/**
 * Customer repositories (ADR-064 point 1, D-39): a Nuzm-owned GitHub App behind this interface. Installation tokens are minted per call and kept
 * only in memory until they expire — never stored, never logged. Nothing here force-pushes: a branch is moved only forward from the tip the
 * caller read, otherwise the call fails with a conflict.
 */
export interface GitInstallation {
  id: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
}
export interface GitRepo {
  id: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}
export interface GitTree {
  sha: string;
  files: Map<string, string>;
  /** binary or oversized files that were not imported */
  skipped: string[];
}
export abstract class GitHostAdapter {
  abstract readonly kind: 'github-app' | 'fake';
  /** Where the customer installs the App; `state` comes back on the callback and binds it to the organization. */
  abstract installUrl(state: string): string;
  abstract getInstallation(installationId: number): Promise<GitInstallation>;
  abstract listRepos(installationId: number): Promise<GitRepo[]>;
  abstract getRepo(installationId: number, fullName: string): Promise<GitRepo>;
  abstract branchSha(
    installationId: number,
    fullName: string,
    branch: string,
  ): Promise<string | null>;
  abstract readTree(installationId: number, fullName: string, ref: string): Promise<GitTree>;
  /** A commit with exactly `files` (minus `deletes`) on top of `baseSha`, then `branch` moves to it — created if missing, never forced. */
  abstract commit(
    installationId: number,
    fullName: string,
    input: {
      branch: string;
      baseSha: string;
      files: ReadonlyMap<string, string>;
      deletes: readonly string[];
      message: string;
    },
  ): Promise<{ sha: string }>;
  abstract openPullRequest(
    installationId: number,
    fullName: string,
    input: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }>;
  abstract listPullRequests(
    installationId: number,
    fullName: string,
  ): Promise<
    { number: number; title: string; head: string; base: string; url: string; state: string }[]
  >;
  /** HMAC-SHA256 over the RAW body (`X-Hub-Signature-256: sha256=…`), constant-time compare. */
  abstract verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}

export const MAX_IMPORT_FILES = 2000;
export const MAX_IMPORT_FILE_BYTES = 1_000_000;
export const MAX_IMPORT_BYTES = 20_000_000;
const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

export function hmacOk(secret: string, raw: string, signature: string | undefined): boolean {
  if (!secret || !signature || !signature.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw, 'utf8').digest('hex'), 'utf8');
  const got = Buffer.from(signature.slice('sha256='.length), 'utf8');
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface GitHubAppConfig {
  appId: string;
  appSlug: string;
  privateKeyPem: string;
  webhookSecret: string;
}

/** The real GitHub App. Usable only once the owner registered the App and stored its key and webhook secret (HG-AS-01). */
export class GitHubAppAdapter extends GitHostAdapter {
  readonly kind = 'github-app' as const;
  private readonly tokens = new Map<number, { token: string; exp: number }>();
  constructor(
    private readonly cfg: GitHubAppConfig,
    private readonly http: typeof fetch = fetch,
  ) {
    super();
  }
  installUrl(state: string) {
    return `https://github.com/apps/${encodeURIComponent(this.cfg.appSlug)}/installations/new?state=${encodeURIComponent(state)}`;
  }
  private jwt(): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: this.cfg.appId })}`;
    return `${head}.${createSign('RSA-SHA256').update(head).sign(this.cfg.privateKeyPem).toString('base64url')}`;
  }
  private async call(
    path: string,
    init: RequestInit & { auth: 'app' | number },
  ): Promise<Response> {
    const auth =
      init.auth === 'app' ? `Bearer ${this.jwt()}` : `token ${await this.token(init.auth)}`;
    const r = await this.http(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'nuzm-github-app',
        authorization: auth,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401)
      throw new ProblemException('service_unavailable', 'GitHub refused the App credentials');
    if (r.status === 403 || r.status === 404)
      throw new ProblemException(
        'not_found',
        'not found, or the App has no access to it (check the installation permissions)',
      );
    if (r.status === 409 || r.status === 422)
      throw new ProblemException(
        'conflict',
        'GitHub refused the change (branch moved, protected or conflicting)',
      );
    if (r.status === 429) throw new ProblemException('rate_limited', 'GitHub rate limit reached');
    if (!r.ok) throw new ProblemException('service_unavailable', `GitHub answered ${r.status}`);
    return r;
  }
  private async token(installationId: number): Promise<string> {
    const c = this.tokens.get(installationId);
    if (c && c.exp > Date.now() + 60_000) return c.token;
    const j = (await (
      await this.call(`/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        auth: 'app',
      })
    ).json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, { token: j.token, exp: Date.parse(j.expires_at) });
    return j.token;
  }
  async getInstallation(id: number): Promise<GitInstallation> {
    const j = (await (
      await this.call(`/app/installations/${id}`, { method: 'GET', auth: 'app' })
    ).json()) as {
      id: number;
      account: { login: string; type: string };
      repository_selection: string;
    };
    return {
      id: j.id,
      accountLogin: j.account.login,
      accountType: j.account.type === 'Organization' ? 'Organization' : 'User',
      repositorySelection: j.repository_selection === 'all' ? 'all' : 'selected',
    };
  }
  private repo = (r: {
    id: number;
    full_name: string;
    default_branch: string;
    private: boolean;
  }): GitRepo => ({
    id: r.id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private,
  });
  async listRepos(id: number) {
    const out: GitRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const j = (await (
        await this.call(`/installation/repositories?per_page=100&page=${page}`, {
          method: 'GET',
          auth: id,
        })
      ).json()) as { repositories: Parameters<GitHubAppAdapter['repo']>[0][] };
      out.push(...j.repositories.map(this.repo));
      if (j.repositories.length < 100) break;
    }
    return out;
  }
  async getRepo(id: number, fullName: string) {
    return this.repo(
      (await (
        await this.call(`/repos/${fullName}`, { method: 'GET', auth: id })
      ).json()) as Parameters<GitHubAppAdapter['repo']>[0],
    );
  }
  async branchSha(id: number, fullName: string, branch: string) {
    try {
      const j = (await (
        await this.call(`/repos/${fullName}/git/ref/heads/${encodeURIComponent(branch)}`, {
          method: 'GET',
          auth: id,
        })
      ).json()) as { object: { sha: string } };
      return j.object.sha;
    } catch (e) {
      if (e instanceof ProblemException && e.code === 'not_found') return null;
      throw e;
    }
  }
  async readTree(id: number, fullName: string, ref: string): Promise<GitTree> {
    const sha = (await this.branchSha(id, fullName, ref)) ?? ref;
    const commit = (await (
      await this.call(`/repos/${fullName}/git/commits/${sha}`, { method: 'GET', auth: id })
    ).json()) as { sha: string; tree: { sha: string } };
    const tree = (await (
      await this.call(`/repos/${fullName}/git/trees/${commit.tree.sha}?recursive=1`, {
        method: 'GET',
        auth: id,
      })
    ).json()) as {
      tree: { path: string; type: string; mode: string; sha: string; size?: number }[];
      truncated: boolean;
    };
    if (tree.truncated)
      throw new ProblemException('payload_too_large', 'the repository is too large to import');
    const files = new Map<string, string>();
    const skipped: string[] = [];
    let total = 0;
    for (const e of tree.tree.filter((x) => x.type === 'blob')) {
      if (
        e.mode === '120000' ||
        (e.size ?? 0) > MAX_IMPORT_FILE_BYTES ||
        files.size >= MAX_IMPORT_FILES
      ) {
        skipped.push(e.path);
        continue;
      }
      const blob = (await (
        await this.call(`/repos/${fullName}/git/blobs/${e.sha}`, { method: 'GET', auth: id })
      ).json()) as { content: string };
      const buf = Buffer.from(blob.content, 'base64');
      total += buf.byteLength;
      if (total > MAX_IMPORT_BYTES)
        throw new ProblemException(
          'payload_too_large',
          'the repository is larger than 20 MB of text',
        );
      if (looksBinary(buf)) skipped.push(e.path);
      else files.set(e.path, buf.toString('utf8'));
    }
    return { sha: commit.sha, files, skipped };
  }
  async commit(
    id: number,
    fullName: string,
    input: {
      branch: string;
      baseSha: string;
      files: ReadonlyMap<string, string>;
      deletes: readonly string[];
      message: string;
    },
  ) {
    const base = (await (
      await this.call(`/repos/${fullName}/git/commits/${input.baseSha}`, {
        method: 'GET',
        auth: id,
      })
    ).json()) as { tree: { sha: string } };
    const tree = [
      ...[...input.files].map(([path, content]) => ({
        path,
        mode: '100644',
        type: 'blob',
        content,
      })),
      ...input.deletes.map((path) => ({ path, mode: '100644', type: 'blob', sha: null })),
    ];
    const t = (await (
      await this.call(`/repos/${fullName}/git/trees`, {
        method: 'POST',
        auth: id,
        body: JSON.stringify({ base_tree: base.tree.sha, tree }),
      })
    ).json()) as { sha: string };
    const c = (await (
      await this.call(`/repos/${fullName}/git/commits`, {
        method: 'POST',
        auth: id,
        body: JSON.stringify({ message: input.message, tree: t.sha, parents: [input.baseSha] }),
      })
    ).json()) as { sha: string };
    const tip = await this.branchSha(id, fullName, input.branch);
    if (tip === null)
      await this.call(`/repos/${fullName}/git/refs`, {
        method: 'POST',
        auth: id,
        body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: c.sha }),
      });
    else if (tip !== input.baseSha)
      throw new ProblemException('conflict', `${input.branch} moved on GitHub; pull first`);
    else
      await this.call(`/repos/${fullName}/git/refs/heads/${encodeURIComponent(input.branch)}`, {
        method: 'PATCH',
        auth: id,
        body: JSON.stringify({ sha: c.sha, force: false }),
      });
    return { sha: c.sha };
  }
  async openPullRequest(
    id: number,
    fullName: string,
    input: { head: string; base: string; title: string; body: string },
  ) {
    const j = (await (
      await this.call(`/repos/${fullName}/pulls`, {
        method: 'POST',
        auth: id,
        body: JSON.stringify(input),
      })
    ).json()) as { number: number; html_url: string };
    return { number: j.number, url: j.html_url };
  }
  async listPullRequests(id: number, fullName: string) {
    const j = (await (
      await this.call(`/repos/${fullName}/pulls?state=open&per_page=50`, {
        method: 'GET',
        auth: id,
      })
    ).json()) as {
      number: number;
      title: string;
      html_url: string;
      state: string;
      head: { ref: string };
      base: { ref: string };
    }[];
    return j.map((p) => ({
      number: p.number,
      title: p.title,
      head: p.head.ref,
      base: p.base.ref,
      url: p.html_url,
      state: p.state,
    }));
  }
  verifyWebhook(raw: string, signature: string | undefined) {
    return hmacOk(this.cfg.webhookSecret, raw, signature);
  }
}

interface FakeRepo extends GitRepo {
  installationId: number;
  branches: Map<string, string>;
  commits: Map<string, Map<string, string>>;
  pulls: {
    number: number;
    title: string;
    head: string;
    base: string;
    url: string;
    state: string;
  }[];
}
/** In-memory GitHub for development and tests (D-39 live use is BLOCKED until HG-AS-01). Same contract, no network. */
export class FakeGitHostAdapter extends GitHostAdapter {
  readonly kind = 'fake' as const;
  readonly installations = new Map<number, GitInstallation>();
  readonly repos = new Map<string, FakeRepo>();
  constructor(readonly webhookSecret = 'fake-webhook-secret-for-tests') {
    super();
  }
  addInstallation(i: GitInstallation) {
    this.installations.set(i.id, i);
  }
  addRepo(
    installationId: number,
    fullName: string,
    files: Record<string, string>,
    isPrivate = true,
  ) {
    const sha = randomUUID().replace(/-/g, '').padEnd(40, '0').slice(0, 40);
    const r: FakeRepo = {
      id: this.repos.size + 1000,
      fullName,
      defaultBranch: 'main',
      private: isPrivate,
      installationId,
      branches: new Map([['main', sha]]),
      commits: new Map([[sha, new Map(Object.entries(files))]]),
      pulls: [],
    };
    this.repos.set(fullName, r);
    return r;
  }
  installUrl(state: string) {
    return `https://github.example.invalid/apps/nuzm-dev/installations/new?state=${encodeURIComponent(state)}`;
  }
  private r(id: number, fullName: string) {
    const r = this.repos.get(fullName);
    if (!r || r.installationId !== id)
      throw new ProblemException('not_found', 'not found, or the App has no access to it');
    return r;
  }
  async getInstallation(id: number) {
    const i = this.installations.get(id);
    if (!i) throw new ProblemException('not_found', 'installation not found');
    return i;
  }
  async listRepos(id: number) {
    return [...this.repos.values()]
      .filter((r) => r.installationId === id)
      .map(({ id: rid, fullName, defaultBranch, private: p }) => ({
        id: rid,
        fullName,
        defaultBranch,
        private: p,
      }));
  }
  async getRepo(id: number, fullName: string) {
    const r = this.r(id, fullName);
    return { id: r.id, fullName: r.fullName, defaultBranch: r.defaultBranch, private: r.private };
  }
  async branchSha(id: number, fullName: string, branch: string) {
    return this.r(id, fullName).branches.get(branch) ?? null;
  }
  async readTree(id: number, fullName: string, ref: string) {
    const r = this.r(id, fullName);
    const sha = r.branches.get(ref) ?? ref;
    const files = r.commits.get(sha);
    if (!files) throw new ProblemException('not_found', 'ref not found');
    return { sha, files: new Map(files), skipped: [] };
  }
  async commit(
    id: number,
    fullName: string,
    input: {
      branch: string;
      baseSha: string;
      files: ReadonlyMap<string, string>;
      deletes: readonly string[];
      message: string;
    },
  ) {
    const r = this.r(id, fullName);
    const base = r.commits.get(input.baseSha);
    if (!base) throw new ProblemException('not_found', 'base commit not found');
    const tip = r.branches.get(input.branch);
    if (tip !== undefined && tip !== input.baseSha)
      throw new ProblemException('conflict', `${input.branch} moved on GitHub; pull first`);
    const next = new Map(base);
    for (const [p, c] of input.files) next.set(p, c);
    for (const p of input.deletes) next.delete(p);
    const sha = randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40);
    r.commits.set(sha, next);
    r.branches.set(input.branch, sha);
    return { sha };
  }
  async openPullRequest(
    id: number,
    fullName: string,
    input: { head: string; base: string; title: string; body: string },
  ) {
    const r = this.r(id, fullName);
    if (!r.branches.has(input.head))
      throw new ProblemException('conflict', 'the head branch does not exist');
    const number = r.pulls.length + 1;
    const url = `https://github.example.invalid/${fullName}/pull/${number}`;
    r.pulls.push({
      number,
      title: input.title,
      head: input.head,
      base: input.base,
      url,
      state: 'open',
    });
    return { number, url };
  }
  async listPullRequests(id: number, fullName: string) {
    return this.r(id, fullName).pulls;
  }
  verifyWebhook(raw: string, signature: string | undefined) {
    return hmacOk(this.webhookSecret, raw, signature);
  }
}
