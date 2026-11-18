import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { classifyIpLiteral } from '../sandbox/egress';

/**
 * Deploy-side ports (assumptions A-05..A-08 in docs/reports/M10-m09-interface-assumptions.md).
 *  - `DeployTargetPort`: where a build is placed. The real implementations are an M06 hosting site (`HostingAdapter` deploy-capable path) and an M05 compute instance; NEITHER is
 *    wired here. `DevStaticTarget` is the in-memory "dev static target" of the M10 prompt (§2): it proves the pipeline, it is not a hosting provider.
 *  - `ReleaseStorePort`: content-addressed release artifacts (M08 bucket in the project's region in production).
 *  - `HealthProbePort`: the health gate. `HttpHealthProbe` refuses non-public addresses (SSRF), `ScriptedHealthProbe` serves tests.
 */
export interface DeployTarget {
  id: string;
  orgId: string;
  type: 'site' | 'instance';
  region: string;
  status: 'active' | 'suspended';
  /** True when deploying here needs a NEW paid resource (compute/database/domain): the `paid_resource` approval gates it. */
  newPaidResource: boolean;
  baseUrl: string;
}
export interface TargetDeployResult {
  url: string;
  releaseRef: string;
}
export abstract class DeployTargetPort {
  /** The target if it belongs to the organization (null otherwise: the caller answers 404, never revealing another org's target). */
  abstract resolve(orgId: string, target: { type: 'site' | 'instance'; id: string }): Promise<DeployTarget | null>;
  abstract appliedMigrations(orgId: string, targetId: string): Promise<number[]>;
  abstract deploy(orgId: string, targetId: string, release: { artifactRef: string; sha256: string; deploymentId: string; environment: string; migrations: { version: number; up: string }[] }): Promise<TargetDeployResult>;
  /** Makes an earlier release the live one again (rollback and auto-rollback). */
  abstract activate(orgId: string, targetId: string, releaseRef: string): Promise<void>;
  abstract currentRelease(orgId: string, targetId: string): Promise<string | null>;
}
export abstract class ReleaseStorePort {
  abstract put(orgId: string, sha256: string, bytes: Buffer): Promise<string>;
  abstract get(orgId: string, ref: string): Promise<Buffer | null>;
  /** URL valid for `ttlSeconds` (callers cap it at 900). */
  abstract signedUrl(orgId: string, ref: string, ttlSeconds: number, now: Date): string;
  abstract verify(url: string, now: Date): { orgId: string; ref: string } | null;
}
export abstract class HealthProbePort {
  abstract check(url: string): Promise<{ ok: boolean; status: number | null; detail: string }>;
}

export class DevStaticTarget extends DeployTargetPort {
  readonly targets = new Map<string, DeployTarget>();
  readonly releases = new Map<string, { targetId: string; sha256: string; deploymentId: string; migrations: number[] }>();
  private readonly live = new Map<string, string>();
  private readonly applied = new Map<string, Set<number>>();
  /** Test hooks: fail the next deploy call / make the health endpoint answer 503. */
  failNextDeploy = false;
  register(t: Omit<DeployTarget, 'baseUrl'> & { baseUrl?: string }): DeployTarget {
    const full = { baseUrl: `https://${t.id}.dev-static.invalid`, ...t };
    this.targets.set(t.id, full);
    return full;
  }
  async resolve(orgId: string, target: { type: 'site' | 'instance'; id: string }) {
    const t = this.targets.get(target.id);
    return t && t.orgId === orgId && t.type === target.type ? { ...t } : null;
  }
  async appliedMigrations(_org: string, targetId: string) {
    return [...(this.applied.get(targetId) ?? [])].sort((a, b) => a - b);
  }
  async deploy(_org: string, targetId: string, r: Parameters<DeployTargetPort['deploy']>[2]) {
    if (this.failNextDeploy) {
      this.failNextDeploy = false;
      throw new Error('the target refused the release');
    }
    const releaseRef = `rel_${randomBytes(6).toString('hex')}`;
    this.releases.set(releaseRef, { targetId, sha256: r.sha256, deploymentId: r.deploymentId, migrations: r.migrations.map((m) => m.version) });
    const set = this.applied.get(targetId) ?? new Set<number>();
    for (const m of r.migrations) set.add(m.version);
    this.applied.set(targetId, set);
    this.live.set(targetId, releaseRef);
    return { url: `${this.targets.get(targetId)!.baseUrl}/`, releaseRef };
  }
  async activate(_org: string, targetId: string, releaseRef: string) {
    if (this.releases.get(releaseRef)?.targetId !== targetId) throw new Error('unknown release');
    this.live.set(targetId, releaseRef);
  }
  async currentRelease(_org: string, targetId: string) {
    return this.live.get(targetId) ?? null;
  }
}

export class MemoryReleaseStore extends ReleaseStorePort {
  private readonly items = new Map<string, { orgId: string; bytes: Buffer }>();
  private readonly key = randomBytes(32);
  async put(orgId: string, sha: string, bytes: Buffer) {
    const ref = `rel-${sha.slice(0, 16)}`;
    this.items.set(`${orgId}:${ref}`, { orgId, bytes });
    return ref;
  }
  async get(orgId: string, ref: string) {
    return this.items.get(`${orgId}:${ref}`)?.bytes ?? null;
  }
  signedUrl(orgId: string, ref: string, ttlSeconds: number, now: Date): string {
    const exp = Math.floor(now.getTime() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', this.key).update(`${orgId}|${ref}|${exp}`).digest('base64url');
    return `https://exports.dev.invalid/${orgId}/${ref}?exp=${exp}&sig=${sig}`;
  }
  verify(url: string, now: Date) {
    const m = /^https:\/\/exports\.dev\.invalid\/([^/]+)\/([^?]+)\?exp=(\d+)&sig=([\w-]+)$/.exec(url);
    if (!m) return null;
    const expected = createHmac('sha256', this.key).update(`${m[1]}|${m[2]}|${m[3]}`).digest('base64url');
    return expected === m[4] && Number(m[3]) * 1000 > now.getTime() ? { orgId: m[1]!, ref: m[2]! } : null;
  }
}

export class ScriptedHealthProbe extends HealthProbePort {
  /** url prefix -> answers in order (the last one repeats). */
  private readonly script: { match: (url: string) => boolean; answers: { ok: boolean; status: number | null; detail: string }[] }[] = [];
  readonly calls: string[] = [];
  healthyByDefault = true;
  failWhen(match: (url: string) => boolean, answers = [{ ok: false, status: 503, detail: 'service unavailable' }]) {
    this.script.unshift({ match, answers: [...answers] });
  }
  clear() {
    this.script.length = 0;
  }
  async check(url: string) {
    this.calls.push(url);
    const s = this.script.find((x) => x.match(url));
    if (s) return s.answers.length > 1 ? s.answers.shift()! : s.answers[0]!;
    return this.healthyByDefault ? { ok: true, status: 200, detail: 'ok' } : { ok: false, status: 503, detail: 'unhealthy' };
  }
}

/** Real HTTP health probe. The control plane fetches a URL the customer controls: IP literals in blocked ranges and metadata hosts are refused (SSRF), redirects are not followed, the body is capped, the time is bounded. NOT VERIFIED against a live target. */
export class HttpHealthProbe extends HealthProbePort {
  constructor(private readonly resolve: (host: string) => Promise<string[]>, private readonly timeoutMs = 5000) {
    super();
  }
  async check(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, status: null, detail: 'invalid URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, status: null, detail: 'scheme not allowed' };
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const lit = classifyIpLiteral(host);
    const addrs = lit.literal ? [host] : await this.resolve(host).catch(() => []);
    if (addrs.length === 0) return { ok: false, status: null, detail: 'the name did not resolve' };
    for (const a of addrs) {
      const c = classifyIpLiteral(a);
      if (!c.literal || c.blocked || c.metadata || !isIP(a.replace(/^\[|\]$/g, ''))) return { ok: false, status: null, detail: 'the target resolves to a non-public address' };
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await fetch(url, { redirect: 'manual', signal: ctl.signal });
      return { ok: r.status === 200, status: r.status, detail: r.status === 200 ? 'ok' : `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, status: null, detail: (e as Error).name === 'AbortError' ? 'timed out' : 'connection failed' };
    } finally {
      clearTimeout(t);
    }
  }
}
