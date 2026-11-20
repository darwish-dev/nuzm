import { ProblemException } from '../../../../common/errors';

/**
 * Where third-party skills come from (ADR-064 point 2): an ANONYMOUS, read-only fetch of one folder of a public repository at a pinned commit.
 * It never carries customer credentials and is a different path from the customer GitHub App integration (D-40). Nothing fetched is executed;
 * the files go to quarantine (an unapproved skill version) and through the scanner.
 */
export interface SkillSourceFile {
  /** relative to the skill folder */
  path: string;
  /** text; null for a binary file (refused at import) */
  content: string | null;
  executable: boolean;
  bytes: number;
}
export interface SkillSourceResult {
  /** the immutable commit the files were read at */
  commit: string;
  files: SkillSourceFile[];
}
export abstract class SkillSource {
  abstract readonly kind: 'github-public' | 'fake';
  abstract fetch(repo: string, ref: string, folder: string): Promise<SkillSourceResult>;
}

export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
export const REF_RE = /^[A-Za-z0-9._/-]{1,100}$/;
export const FOLDER_RE = /^(?:[A-Za-z0-9_.-]+\/){0,8}[A-Za-z0-9_.-]+$|^$/;
const MAX_FILES = 200;
const MAX_TOTAL = 2_000_000;

const binary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

/** Public GitHub over HTTPS. The two hosts are fixed in code (never from a request), redirects are refused, every call has a timeout. */
export class GithubPublicSkillSource extends SkillSource {
  readonly kind = 'github-public' as const;
  constructor(private readonly http: typeof fetch = fetch) {
    super();
  }
  private async get(url: string, accept: string) {
    const r = await this.http(url, {
      headers: { accept, 'user-agent': 'nuzm-skills-importer' },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404)
      throw new ProblemException('not_found', 'repository, ref or folder not found');
    if (r.status === 403 || r.status === 429)
      throw new ProblemException(
        'rate_limited',
        'GitHub refused the request (rate limit); try again later',
      );
    if (!r.ok) throw new ProblemException('service_unavailable', `GitHub answered ${r.status}`);
    return r;
  }
  async fetch(repo: string, ref: string, folder: string): Promise<SkillSourceResult> {
    const api = 'https://api.github.com';
    const commit = (
      (await (
        await this.get(
          `${api}/repos/${repo}/commits/${encodeURIComponent(ref)}`,
          'application/vnd.github+json',
        )
      ).json()) as { sha?: string }
    ).sha;
    if (!commit || !/^[0-9a-f]{40}$/.test(commit))
      throw new ProblemException('service_unavailable', 'GitHub returned no commit');
    const tree = (await (
      await this.get(
        `${api}/repos/${repo}/git/trees/${commit}?recursive=1`,
        'application/vnd.github+json',
      )
    ).json()) as {
      tree?: { path: string; type: string; mode: string; size?: number }[];
      truncated?: boolean;
    };
    const prefix = folder ? `${folder}/` : '';
    const blobs = (tree.tree ?? []).filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
    if (!blobs.length)
      throw new ProblemException('not_found', 'the folder has no files at that commit');
    if (blobs.length > MAX_FILES || tree.truncated)
      throw new ProblemException(
        'payload_too_large',
        `a skill may have at most ${MAX_FILES} files`,
      );
    const total = blobs.reduce((n, b) => n + (b.size ?? 0), 0);
    if (total > MAX_TOTAL)
      throw new ProblemException('payload_too_large', 'the skill is larger than 2 MB');
    const files: SkillSourceFile[] = [];
    for (const b of blobs) {
      if (b.mode === '120000')
        throw new ProblemException(
          'validation_failed',
          `symbolic links are not accepted (${b.path})`,
        );
      const raw = new Uint8Array(
        await (
          await this.get(`https://raw.githubusercontent.com/${repo}/${commit}/${b.path}`, '*/*')
        ).arrayBuffer(),
      );
      files.push({
        path: b.path.slice(prefix.length),
        content: binary(raw) ? null : new TextDecoder('utf-8', { fatal: false }).decode(raw),
        executable: b.mode === '100755',
        bytes: raw.byteLength,
      });
    }
    return { commit, files };
  }
}

/** In-memory source for development and tests: `repo@ref:folder` → files. */
export class FakeSkillSource extends SkillSource {
  readonly kind = 'fake' as const;
  readonly repos = new Map<string, SkillSourceResult>();
  put(repo: string, ref: string, folder: string, r: SkillSourceResult) {
    this.repos.set(`${repo}@${ref}:${folder}`, r);
  }
  async fetch(repo: string, ref: string, folder: string): Promise<SkillSourceResult> {
    const r = this.repos.get(`${repo}@${ref}:${folder}`);
    if (!r) throw new ProblemException('not_found', 'repository, ref or folder not found');
    return r;
  }
}
