/**
 * Tracks F (real application PREVIEW) and G (real STAGING DEPLOYMENT) — Phase 2, Session 06. One runner, two procedures, one evidence record.
 *
 *  F `preview`: put a build of an application on the target as a STAGED release, smoke it at its temporary subdomain, then discard it. The live site is never switched.
 *  G `deploy` : release 1 → smoke staged → switch → smoke live → release 2 → switch → ROLLBACK to release 1 → smoke after rollback.
 *
 * Both run SIMULATED today (in-memory node) and are labelled so. In `real` mode the runner REFUSES (BLOCKED, nothing deployed) unless ALL of these hold:
 *   - a staging target record (strictly parsed, no secrets in it) that passes the target gate (HG-05/HG-06 reference format, preview domain, ADR-060 separation);
 *   - BOTH owner approval references: `HG-05:<id>` (the node) and `HG-06:<id>` (the node's panel access), well formed;
 *   - an artifact transport that can reach the node (none exists yet: the SFTP path is not built, so a real run ends BLOCKED today).
 * A record can claim `LIVE-VERIFIED` only if `validateLiveEvidence` accepts it: real mode, all paths 200 over https, an issued/not-required SSL state, a rollback that served
 * release 1 again, ordered timestamps, both approval references, and no simulated marker anywhere. This module never reads a clock itself (`now` is injected).
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
import { syntheticApp, SMOKE_PATHS } from './rehearsal';

export type Track = 'F' | 'G';
export const EVIDENCE_SCHEMA = 'nuzm.staging-evidence/1';
export const HG05_REF = /^HG-05:[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/;
export const HG06_REF = /^HG-06:[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/;

/* ───────────── staging target record (a file the owner/admin writes; never contains a secret) ───────────── */
const TARGET_KEYS = [
  'id',
  'kind',
  'provider',
  'verification',
  'region',
  'previewDomain',
  'approvalRef',
  'evidenceRef',
] as const;

export type TargetRecordResult =
  { ok: true; target: StagingTarget } | { ok: false; problems: string[] };

/** Strict parse of a staging target record: exactly the known keys, strings only, bounded; anything else (including a credential-looking key) is refused unechoed. */
export function parseStagingTargetRecord(text: string): TargetRecordResult {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { ok: false, problems: ['the staging target record is not valid JSON'] };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j))
    return { ok: false, problems: ['the staging target record must be a JSON object'] };
  const o = j as Record<string, unknown>;
  const problems: string[] = [];
  for (const k of Object.keys(o))
    if (!(TARGET_KEYS as readonly string[]).includes(k))
      problems.push(
        `unknown field (only ${TARGET_KEYS.join(', ')} are allowed; secrets never belong here)`,
      );
  const str = (k: string, nullable = false): string | null => {
    const v = o[k];
    if (v === null && nullable) return null;
    if (typeof v !== 'string' || v.length === 0 || v.length > 253) {
      problems.push(`${k} must be a non-empty string`);
      return null;
    }
    return v;
  };
  const kind = str('kind');
  const provider = str('provider');
  const verification = str('verification');
  if (
    kind &&
    !['static_hosting', 'isolated_runtime', 'managed_database', 'store_distribution'].includes(kind)
  )
    problems.push('kind is not a known target kind');
  if (provider && !['in_memory', 'hosting_panel', 'isolated_runtime'].includes(provider))
    problems.push('provider is not a known provider');
  if (verification && !['SIMULATED', 'NOT VERIFIED', 'LIVE-VERIFIED'].includes(verification))
    problems.push('verification is not a known label');
  const id = str('id');
  const region = str('region');
  const previewDomain = 'previewDomain' in o ? str('previewDomain', true) : null;
  const approvalRef = 'approvalRef' in o ? str('approvalRef', true) : null;
  const evidenceRef = 'evidenceRef' in o ? str('evidenceRef', true) : null;
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    target: {
      id: id!,
      kind: kind as StagingTarget['kind'],
      provider: provider as StagingTarget['provider'],
      verification: verification as TargetVerification,
      region: region!,
      previewDomain,
      approvalRef,
      evidenceRef,
    },
  };
}

/* ───────────── the evidence record ───────────── */
export interface EvidenceStep {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  detail: string;
  at: string;
}
export interface HealthResult {
  ok: boolean;
  tls: boolean | null;
  paths: { path: string; status: number }[];
}
export interface LiveEvidenceRecord {
  schema: typeof EVIDENCE_SCHEMA;
  track: Track;
  mode: 'simulated' | 'real';
  /** SIMULATED for any simulated run; otherwise the target's own label. A record is LIVE-VERIFIED only if `validateLiveEvidence` accepts it. */
  label: TargetVerification;
  status: 'PASS' | 'FAIL' | 'BLOCKED';
  target: {
    id: string;
    provider: string;
    region: string;
    previewDomain: string | null;
    hg05Ref: string | null;
    hg06Ref: string | null;
  };
  app: { hash: string; files: number };
  /** release ids are the deployment ids given to the node; `previous` is the release rolled back to / left live */
  release: { id: string | null; previous: string | null };
  url: string | null;
  health: HealthResult | null;
  ssl: { state: string; action: string; label: string } | null;
  rollback: { performed: boolean; servedHash: string | null; ok: boolean } | null;
  steps: EvidenceStep[];
  timestamps: { startedAt: string; finishedAt: string };
  conclusion: string;
}

export interface LiveTrackInput {
  track: Track;
  mode?: 'simulated' | 'real';
  target?: StagingTarget;
  hg05Ref?: string | null;
  hg06Ref?: string | null;
  artifact?: Artifact;
  transport?: ArtifactTransport;
  ops?: HostingSiteOps;
  protectedDomains?: readonly string[];
  tagKey?: string;
  site?: Partial<TargetSite>;
  now?: () => Date;
}

const SITE: TargetSite = {
  id: 'staging-site',
  name: 'staging',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};

/** The second release of G: the same application plus a release marker file, so its hash differs and a rollback is observable. */
export function withReleaseMarker(a: Artifact, n: number): Artifact {
  const files = [
    ...a.files.filter((f) => f.path !== 'release.txt'),
    {
      path: 'release.txt',
      mime: 'text/plain',
      content: new TextEncoder().encode(`release ${n}\n`),
    },
  ];
  return { hash: artifactHash(files), files };
}

export async function runLiveTrack(input: LiveTrackInput): Promise<LiveEvidenceRecord> {
  const mode = input.mode ?? 'simulated';
  const target = input.target ?? SIMULATED_STAGING_TARGET;
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const artifact = input.artifact ?? syntheticApp(1);
  const steps: EvidenceStep[] = [];
  const label: TargetVerification = mode === 'simulated' ? 'SIMULATED' : target.verification;
  const rec: LiveEvidenceRecord = {
    schema: EVIDENCE_SCHEMA,
    track: input.track,
    mode,
    label,
    status: 'PASS',
    target: {
      id: target.id,
      provider: target.provider,
      region: target.region,
      previewDomain: target.previewDomain,
      hg05Ref: input.hg05Ref ?? null,
      hg06Ref: input.hg06Ref ?? null,
    },
    app: { hash: artifact.hash, files: artifact.files.length },
    release: { id: null, previous: null },
    url: null,
    health: null,
    ssl: null,
    rollback: null,
    steps,
    timestamps: { startedAt, finishedAt: startedAt },
    conclusion: '',
  };
  const add = (id: string, title: string, status: EvidenceStep['status'], detail: string) =>
    steps.push({ id, title, status, detail, at: now().toISOString() });
  const finish = (status: LiveEvidenceRecord['status'], conclusion: string) => {
    rec.status = status;
    rec.conclusion = conclusion;
    rec.timestamps.finishedAt = now().toISOString();
    return rec;
  };
  const stop = (id: string, title: string, e: unknown) => {
    add(id, title, 'FAIL', e instanceof Error ? e.message : String(e));
    return finish('FAIL', 'FAIL: stopped at a failed step; see the steps.');
  };
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  // gate
  try {
    if (mode === 'simulated') {
      if (target.provider !== 'in_memory')
        throw new StagingTargetRefused(
          'kind_mismatch',
          'a simulated run uses only the in-memory target',
        );
    } else {
      if (!input.hg05Ref || !HG05_REF.test(input.hg05Ref))
        throw new StagingTargetRefused(
          'approval_missing',
          'a real run needs the owner approval reference HG-05:<id> (the node)',
        );
      if (!input.hg06Ref || !HG06_REF.test(input.hg06Ref))
        throw new StagingTargetRefused(
          'approval_missing',
          'a real run needs the owner approval reference HG-06:<id> (the panel access)',
        );
      assertStagingTargetUsable({ ...target, approvalRef: input.hg05Ref }, 'website');
      if (!input.transport || input.transport instanceof UnavailableArtifactTransport)
        throw new StagingTargetRefused(
          'not_implemented',
          'no artifact upload path to a hosting node exists yet (SFTP planned): a real run cannot start',
        );
    }
    add(
      'gate',
      'gate: staging target record, HG-05 and HG-06 references, upload path',
      'PASS',
      `${mode} target ${target.id}`,
    );
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    add(
      'gate',
      'gate: staging target record, HG-05 and HG-06 references, upload path',
      'BLOCKED',
      m,
    );
    return finish('BLOCKED', `BLOCKED: ${m}. Nothing was deployed and nothing was verified.`);
  }

  const transport = input.transport ?? new InMemoryArtifactTransport();
  const ops = input.ops ?? new InMemoryHostingSiteOps();
  // the approval given on the command line is the one the publisher's own seal re-checks
  const sealed: StagingTarget =
    mode === 'real' ? { ...target, approvalRef: input.hg05Ref ?? target.approvalRef } : target;
  const pub = new HostingTargetPublisher(ops, transport, sealed, {
    keepReleases: 3,
    previewDomain: target.previewDomain,
    protectedDomains: input.protectedDomains ?? [],
    ...(input.tagKey ? { tagKey: input.tagKey } : {}),
  });
  const site: TargetSite = { ...SITE, ...input.site };
  const prefix = input.track === 'F' ? 'preview' : 'deploy';
  const r1 = `${prefix}-r1`;
  const r2 = `${prefix}-r2`;
  const health = (s: Awaited<ReturnType<typeof pub.smoke>>): HealthResult => ({
    ok: s.ok,
    tls: s.tls,
    paths: s.results,
  });
  const smokePaths = artifact.files.some((f) => f.path === 'index.html')
    ? SMOKE_PATHS.filter((p) =>
        artifact.files.some(
          (f) => f.path === (p === '/' ? 'index.html' : `${p.slice(1)}index.html`),
        ),
      )
    : [];
  if (!smokePaths.includes('/')) smokePaths.unshift('/');

  try {
    // preview origin and URL
    if (target.previewDomain)
      assertIsolatedPreviewDomain(target.previewDomain, input.protectedDomains ?? []);
    const tmp = temporarySubdomain({
      siteName: site.name,
      deploymentId: r1,
      previewDomain: target.previewDomain,
      protectedDomains: input.protectedDomains ?? [],
      ...(input.tagKey ? { tagKey: input.tagKey } : {}),
    });
    add('preview', 'temporary subdomain on an isolated preview origin (ADR-060)', 'PASS', tmp.host);

    // ssl
    const plan = planSsl({
      hostKind: 'temporary',
      host: tmp.host,
      simulated: pub.simulated,
      hg06Approved: mode === 'real',
      dnsVerified: false,
      cert: { state: 'none', notAfter: null, failures: 0 },
      now: now().toISOString(),
    });
    rec.ssl = { state: plan.state, action: plan.action.kind, label: plan.label };
    need(
      plan.state === 'not_required',
      `the temporary host is not covered by a certificate (${plan.state})`,
    );
    add(
      'ssl',
      'SSL plan for the temporary host',
      'PASS',
      `${plan.state} / ${plan.action.kind} (${plan.label})`,
    );
  } catch (e) {
    return stop('preview', 'preview origin and SSL', e);
  }

  if (input.track === 'F') {
    try {
      const { stagingRef } = await pub.stage(site, artifact, r1);
      add(
        'stage',
        'stage the application build as a release (integrity read-back)',
        'PASS',
        stagingRef,
      );
      const sm = await pub.smoke(site, 'staged', stagingRef, smokePaths);
      rec.release = { id: r1, previous: null };
      rec.health = health(sm);
      rec.url = temporarySubdomain({
        siteName: site.name,
        deploymentId: r1,
        previewDomain: target.previewDomain,
        protectedDomains: input.protectedDomains ?? [],
        ...(input.tagKey ? { tagKey: input.tagKey } : {}),
      }).url;
      need(
        sm.ok,
        `the preview smoke check failed: ${sm.results
          .filter((r) => r.status !== 200)
          .map((r) => `${r.path}=${r.status}`)
          .join(', ')}`,
      );
      add('smoke', 'smoke the preview (HTTP 200 on every page)', 'PASS', smokePaths.join(' '));
      const liveBefore = await pub.activeHash(site);
      await pub.discard(site, stagingRef);
      need((await pub.activeHash(site)) === liveBefore, 'the live site changed during a preview');
      add(
        'discard',
        'discard the preview; the live site was never switched',
        'PASS',
        `live hash ${liveBefore ? liveBefore.slice(0, 12) : 'none'}`,
      );
    } catch (e) {
      return stop('preview-run', 'preview', e);
    }
    return finish(
      'PASS',
      mode === 'simulated'
        ? 'PASS (SIMULATED): the preview procedure works against the in-memory node. NOT VERIFIED on any real node: HG-05 and HG-06 are open.'
        : `PASS (${label}): preview verified on target ${target.id}.`,
    );
  }

  // track G
  const r2art = withReleaseMarker(artifact, 2);
  try {
    const { stagingRef } = await pub.stage(site, artifact, r1);
    const sm = await pub.smoke(site, 'staged', stagingRef, smokePaths);
    need(sm.ok, 'release 1 staged smoke failed');
    need((await pub.activeHash(site)) === null, 'a staged release must not be live');
    const { url } = await pub.activate(site, stagingRef);
    rec.url = url;
    const live = await pub.smoke(site, 'live', null, smokePaths);
    rec.health = health(live);
    need(
      live.ok && (await pub.activeHash(site)) === artifact.hash,
      'release 1 live smoke or hash failed',
    );
    rec.release = { id: r1, previous: null };
    add('release1', 'release 1: stage, read-back, smoke, switch, smoke live', 'PASS', url);
  } catch (e) {
    return stop('release1', 'release 1', e);
  }
  try {
    const { stagingRef } = await pub.stage(site, r2art, r2);
    need(
      (await pub.smoke(site, 'staged', stagingRef, smokePaths)).ok,
      'release 2 staged smoke failed',
    );
    await pub.activate(site, stagingRef);
    need((await pub.activeHash(site)) === r2art.hash, 'release 2 must be live');
    rec.release = { id: r2, previous: r1 };
    add('release2', 'release 2 switched live', 'PASS', r2art.hash.slice(0, 12));
  } catch (e) {
    return stop('release2', 'release 2', e);
  }
  try {
    await pub.restore(site, artifact);
    const served = await pub.activeHash(site);
    const after = await pub.smoke(site, 'live', null, smokePaths);
    rec.rollback = {
      performed: true,
      servedHash: served,
      ok: served === artifact.hash && after.ok,
    };
    rec.health = health(after);
    need(rec.rollback.ok, 'after rollback release 1 must be served and healthy');
    rec.release = { id: r1, previous: r2 };
    add('rollback', 'rollback to release 1 and smoke', 'PASS', `serving ${served?.slice(0, 12)}`);
  } catch (e) {
    return stop('rollback', 'rollback', e);
  }
  return finish(
    'PASS',
    mode === 'simulated'
      ? 'PASS (SIMULATED): the deployment procedure works against the in-memory node. NOT VERIFIED on any real node: HG-05 and HG-06 are open.'
      : `PASS (${label}): staging deployment on target ${target.id}; promote to LIVE-VERIFIED only through validateLiveEvidence.`,
  );
}

/* ───────────── validation: what a LIVE-VERIFIED claim must contain ───────────── */
export interface EvidenceCheck {
  /** structurally complete and consistent */
  valid: boolean;
  /** may be recorded as LIVE-VERIFIED */
  liveEligible: boolean;
  problems: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export function validateLiveEvidence(r: LiveEvidenceRecord): EvidenceCheck {
  const problems: string[] = [];
  const live: string[] = [];
  if (r.schema !== EVIDENCE_SCHEMA) problems.push('unknown evidence schema');
  if (!r.target?.id) problems.push('target id missing');
  if (!r.app?.hash || !/^[0-9a-f]{64}$/.test(r.app.hash)) problems.push('application hash missing');
  if (!r.timestamps || !ISO.test(r.timestamps.startedAt) || !ISO.test(r.timestamps.finishedAt))
    problems.push('timestamps must be ISO-8601 UTC');
  else if (Date.parse(r.timestamps.finishedAt) < Date.parse(r.timestamps.startedAt))
    problems.push('finishedAt is before startedAt');
  let prev = r.timestamps ? Date.parse(r.timestamps.startedAt) : NaN;
  for (const s of r.steps ?? []) {
    const t = Date.parse(s.at);
    if (!ISO.test(s.at) || t < prev)
      problems.push(`step ${s.id}: timestamp missing or out of order`);
    prev = t;
  }
  if (!r.steps?.length) problems.push('no steps recorded');
  // liveness requirements
  if (r.mode !== 'real') live.push('mode is not real');
  if (r.label !== 'LIVE-VERIFIED' && r.label !== 'NOT VERIFIED') live.push(`label is ${r.label}`);
  if (r.status !== 'PASS') live.push(`status is ${r.status}`);
  if (!r.target?.hg05Ref || !HG05_REF.test(r.target.hg05Ref))
    live.push('HG-05 reference missing or malformed');
  if (!r.target?.hg06Ref || !HG06_REF.test(r.target.hg06Ref))
    live.push('HG-06 reference missing or malformed');
  if (!r.release?.id) live.push('release id missing');
  if (!r.url || !r.url.startsWith('https://') || /\.invalid[:/]/.test(r.url))
    live.push('url must be a real https URL');
  if (
    !r.health ||
    !r.health.ok ||
    r.health.tls !== true ||
    !r.health.paths.length ||
    r.health.paths.some((p) => p.status !== 200)
  )
    live.push('health result must be ok over TLS with HTTP 200 on every path');
  if (
    !r.ssl ||
    (r.ssl.state !== 'not_required' && r.ssl.state !== 'active') ||
    r.ssl.label === 'SIMULATED'
  )
    live.push('SSL result must be not_required (wildcard) or active, and not simulated');
  if (r.track === 'G' && (!r.rollback || !r.rollback.performed || !r.rollback.ok))
    live.push('track G needs a performed, successful rollback');
  if (r.steps?.some((s) => s.status !== 'PASS')) live.push('a step did not pass');
  if (r.steps?.some((s) => /SIMULATED|\.invalid/.test(s.detail)))
    live.push('a step still carries a simulated marker');
  if (/SIMULATED/.test(r.conclusion)) live.push('the conclusion says SIMULATED');
  return {
    valid: problems.length === 0,
    liveEligible: problems.length === 0 && live.length === 0,
    problems: [...problems, ...live.map((l) => `not live-eligible: ${l}`)],
  };
}
