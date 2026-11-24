/**
 * Staging rehearsal of a SYNTHETIC app (Phase 2, Session 06): the whole deployment lifecycle run against one target, producing an evidence record. Pure and in-process: it
 * needs no database, no network and no clock of its own, so it runs in `pnpm test` and from `scripts/staging-rehearsal.ts`.
 *
 * Two modes, one procedure:
 *  - `simulated` (default): the in-memory node. Every step result is labelled SIMULATED. Passing proves the procedure and the code paths, nothing about a real node.
 *  - `real`: refuses to start (BLOCKED) unless the target carries the owner's HG-05 approval reference, a preview domain, and a transport that can reach the node. Today no such
 *    transport exists (the artifact upload path is not built), so `real` ends BLOCKED with that exact reason. It never falls back to simulated and never reports a pass.
 *
 * The synthetic app is deterministic static output (no secrets, no customer data, no network calls) so a real run can never leak anything and a result can be compared run to run.
 */
import { artifactHash, type Artifact, type TargetSite } from './ports';
import {
  HostingTargetPublisher,
  InMemoryArtifactTransport,
  InMemoryHostingSiteOps,
  UnavailableArtifactTransport,
  type ArtifactTransport,
  type HostingSiteOps,
} from './hosting-target';
import {
  SIMULATED_STAGING_TARGET,
  StagingTargetRefused,
  assertStagingTargetUsable,
  type StagingTarget,
  type TargetVerification,
} from './targets';
import { assertIsolatedPreviewDomain, temporarySubdomain } from './preview-url';
import { planSsl } from './ssl-flow';
import { redactLogLine, validateEnvBindings } from './env-refs';

export type RehearsalStatus = 'PASS' | 'FAIL' | 'BLOCKED';
export interface RehearsalStep {
  id: string;
  title: string;
  status: RehearsalStatus;
  detail: string;
  /** what this result is evidence of */
  label: TargetVerification;
}
export interface RehearsalReport {
  mode: 'simulated' | 'real';
  target: Pick<StagingTarget, 'id' | 'provider' | 'verification' | 'region' | 'previewDomain'>;
  appHash: string;
  steps: RehearsalStep[];
  /** PASS only if every step passed; BLOCKED if a gate refused; FAIL otherwise */
  status: RehearsalStatus;
  /** the sentence to put in a report: never says verified for a simulated run */
  conclusion: string;
}

/** A tiny deterministic static site: three pages and an asset. `version` changes the content (and therefore the hash). */
export function syntheticApp(version: number): Artifact {
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${body}</p></body></html>`;
  const files = [
    { path: 'index.html', mime: 'text/html', body: page('Synthetic app', `release ${version}`) },
    { path: 'about/index.html', mime: 'text/html', body: page('About', `release ${version}`) },
    { path: 'health/index.html', mime: 'text/html', body: 'ok' },
    {
      path: 'assets/app.css',
      mime: 'text/css',
      body: `body{font-family:sans-serif}/*r${version}*/`,
    },
  ].map((f) => ({ path: f.path, mime: f.mime, content: new TextEncoder().encode(f.body) }));
  return { hash: artifactHash(files), files };
}

export const SMOKE_PATHS = ['/', '/about/', '/health/'];

export interface RehearsalOptions {
  mode?: 'simulated' | 'real';
  target?: StagingTarget;
  /** real mode only: the transport and hosting ops that reach the node */
  transport?: ArtifactTransport;
  ops?: HostingSiteOps;
  /** domains of the console, admin, API and marketing site (ADR-060 separation) */
  protectedDomains?: readonly string[];
  site?: Partial<TargetSite>;
}

const SITE: TargetSite = {
  id: 'rehearsal-site',
  name: 'rehearsal',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};

export async function runStagingRehearsal(opts: RehearsalOptions = {}): Promise<RehearsalReport> {
  const mode = opts.mode ?? 'simulated';
  const target = opts.target ?? SIMULATED_STAGING_TARGET;
  const label: TargetVerification = mode === 'simulated' ? 'SIMULATED' : target.verification;
  const steps: RehearsalStep[] = [];
  const v1 = syntheticApp(1);
  const report = (status: RehearsalStatus, conclusion: string): RehearsalReport => ({
    mode,
    target: {
      id: target.id,
      provider: target.provider,
      verification: target.verification,
      region: target.region,
      previewDomain: target.previewDomain,
    },
    appHash: v1.hash,
    steps,
    status,
    conclusion,
  });
  const add = (id: string, title: string, status: RehearsalStatus, detail: string) =>
    steps.push({ id, title, status, detail, label });

  // 0. gates: a real run needs the owner's approval, a preview domain and a transport that exists
  try {
    if (mode === 'simulated') {
      if (target.provider !== 'in_memory')
        throw new StagingTargetRefused(
          'kind_mismatch',
          'a simulated rehearsal runs only on the in-memory target',
        );
    } else {
      assertStagingTargetUsable(target, 'website');
      if (!opts.transport || opts.transport instanceof UnavailableArtifactTransport)
        throw new StagingTargetRefused(
          'not_implemented',
          'no artifact upload path to a hosting node exists yet (SFTP planned): the real rehearsal cannot run',
        );
    }
    add(
      'gate',
      'target gate (HG-05 approval, preview domain, upload path)',
      'PASS',
      `${mode} target ${target.id} accepted`,
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    add('gate', 'target gate (HG-05 approval, preview domain, upload path)', 'BLOCKED', m);
    return report('BLOCKED', `BLOCKED: ${m}. Nothing was deployed and nothing was verified.`);
  }

  const transport = opts.transport ?? new InMemoryArtifactTransport();
  const ops = opts.ops ?? new InMemoryHostingSiteOps();
  const pub = new HostingTargetPublisher(ops, transport, target, {
    keepReleases: 3,
    previewDomain: target.previewDomain,
    protectedDomains: opts.protectedDomains ?? [],
  });
  const site: TargetSite = { ...SITE, ...opts.site };
  const fail = (id: string, title: string, e: unknown) => {
    add(id, title, 'FAIL', redactLogLine(e instanceof Error ? e.message : String(e)));
    return report('FAIL', 'FAIL: the rehearsal stopped at a failed step; see the steps.');
  };
  const check = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // 1. isolation of the preview origin and the temporary URL
  try {
    if (target.previewDomain)
      assertIsolatedPreviewDomain(target.previewDomain, opts.protectedDomains ?? []);
    const t = temporarySubdomain({
      siteName: site.name,
      deploymentId: 'rehearsal-1',
      previewDomain: target.previewDomain,
      protectedDomains: opts.protectedDomains ?? [],
    });
    check(
      t.simulated === (target.previewDomain === null),
      'simulated URL flag does not match the target',
    );
    add('preview', 'temporary subdomain on an isolated preview origin (ADR-060)', 'PASS', t.host);
  } catch (e) {
    return fail('preview', 'temporary subdomain on an isolated preview origin (ADR-060)', e);
  }

  // 2. SSL plan for the temporary host (wildcard at the edge; real needs HG-06)
  try {
    const plan = planSsl({
      hostKind: 'temporary',
      host: 'x',
      simulated: pub.simulated,
      hg06Approved: false,
      dnsVerified: false,
      cert: { state: 'none', notAfter: null, failures: 0 },
      now: '2026-01-01T00:00:00Z',
    });
    if (pub.simulated)
      check(plan.state === 'not_required', 'a simulated temporary host needs no certificate');
    add(
      'ssl',
      'SSL plan for the temporary host',
      'PASS',
      `${plan.state} / ${plan.action.kind} (${plan.label})`,
    );
  } catch (e) {
    return fail('ssl', 'SSL plan for the temporary host', e);
  }

  // 3. environment variables: references only
  try {
    const ok = validateEnvBindings(
      [{ name: 'PUBLIC_SITE_NAME', ref: 'vault://orgs/rehearsal/site-name', public: true }],
      'static_hosting',
    );
    check(ok.ok, 'a public build variable reference must validate');
    const bad = validateEnvBindings(
      [{ name: 'DB_PASSWORD', ref: 'hunter2-value' }],
      'static_hosting',
    );
    check(
      !bad.ok && !JSON.stringify(bad).includes('hunter2'),
      'a pasted secret must be refused without being echoed',
    );
    add(
      'env',
      'environment variables are vault references; a pasted secret is refused unechoed',
      'PASS',
      '1 reference accepted, 1 secret refused',
    );
  } catch (e) {
    return fail('env', 'environment variables are vault references', e);
  }

  // 4. release 1: stage → read-back → smoke staged → switch → smoke live
  const urls: string[] = [];
  try {
    const { stagingRef } = await pub.stage(site, v1, 'rehearsal-1');
    const sm = await pub.smoke(site, 'staged', stagingRef, SMOKE_PATHS);
    check(sm.ok, 'the staged smoke check failed');
    check((await pub.activeHash(site)) === null, 'the staged release must not be live');
    const { url } = await pub.activate(site, stagingRef);
    urls.push(url);
    const live = await pub.smoke(site, 'live', null, SMOKE_PATHS);
    check(
      live.ok && (await pub.activeHash(site)) === v1.hash,
      'the live smoke check or the live hash failed',
    );
    add(
      'release1',
      'release 1: stage, integrity read-back, smoke, switch, smoke live',
      'PASS',
      url,
    );
  } catch (e) {
    return fail('release1', 'release 1', e);
  }

  // 5. release 2 with a smoke failure: the staged release is discarded and release 1 keeps serving (failed-deployment recovery)
  try {
    const v2 = syntheticApp(2);
    const { stagingRef } = await pub.stage(site, v2, 'rehearsal-2');
    const sm = await pub.smoke(site, 'staged', stagingRef, [...SMOKE_PATHS, '/missing-page/']);
    check(!sm.ok, 'a missing page must fail the smoke check');
    await pub.discard(site, stagingRef);
    check(
      (await pub.activeHash(site)) === v1.hash,
      'release 1 must still be live after a failed release 2',
    );
    add(
      'recovery',
      'failed smoke: staged release discarded, release 1 keeps serving',
      'PASS',
      `staged smoke: ${sm.results
        .filter((r) => r.status !== 200)
        .map((r) => `${r.path}=${r.status}`)
        .join(', ')}`,
    );
  } catch (e) {
    return fail('recovery', 'failed deployment recovery', e);
  }

  // 6. cancellation between stage and switch
  try {
    const v3 = syntheticApp(3);
    const { stagingRef } = await pub.stage(site, v3, 'rehearsal-cancel');
    await pub.discard(site, stagingRef);
    check(
      (await pub.activeHash(site)) === v1.hash,
      'a cancelled deployment must not touch the live site',
    );
    add(
      'cancel',
      'cancellation after staging: upload discarded, live site untouched',
      'PASS',
      'release 1 still live',
    );
  } catch (e) {
    return fail('cancel', 'cancellation', e);
  }

  // 7. release 2 succeeds, then rollback to release 1 (retained release: no re-upload)
  try {
    const v2 = syntheticApp(2);
    const { stagingRef } = await pub.stage(site, v2, 'rehearsal-2b');
    check(
      (await pub.smoke(site, 'staged', stagingRef, SMOKE_PATHS)).ok,
      'release 2 staged smoke failed',
    );
    await pub.activate(site, stagingRef);
    check((await pub.activeHash(site)) === v2.hash, 'release 2 must be live');
    await pub.restore(site, v1);
    check((await pub.activeHash(site)) === v1.hash, 'rollback must serve release 1 again');
    check((await pub.smoke(site, 'live', null, SMOKE_PATHS)).ok, 'smoke after rollback failed');
    add(
      'rollback',
      'release 2 live, then rollback to release 1',
      'PASS',
      `serving ${v1.hash.slice(0, 12)}`,
    );
  } catch (e) {
    return fail('rollback', 'rollback', e);
  }

  // 8. tenant isolation of the target: a second site on the same node never sees the first site's releases
  try {
    const other: TargetSite = { ...site, id: `${site.id}-other`, name: 'other-tenant' };
    check((await pub.activeHash(other)) === null, 'another site must not serve this site content');
    check(!(await transport.listReleases(other)).length, 'another site must have no releases');
    add(
      'isolation',
      'a second site on the node shares nothing with the first',
      'PASS',
      'no releases, nothing live',
    );
  } catch (e) {
    return fail('isolation', 'tenant isolation of the target', e);
  }

  const conclusion =
    mode === 'simulated'
      ? 'PASS (SIMULATED): the procedure and code paths work against the in-memory node. NOT VERIFIED on any real node: HG-05 and HG-06 are open.'
      : target.verification === 'LIVE-VERIFIED'
        ? 'PASS (LIVE-VERIFIED): evidence reference recorded on the target.'
        : 'PASS (NOT VERIFIED target): the run passed but the target has no recorded live verification.';
  return report('PASS', conclusion);
}
