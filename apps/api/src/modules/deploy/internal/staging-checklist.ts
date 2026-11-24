/**
 * The 12 staging checks of docs/parallel/STAGING-DEPLOYMENT-PLAN.md section 11 as ONE executable run (Phase 3, P3-S07). Each row is a recorded event with its approval references,
 * its timestamp and a status in the project vocabulary (PASS / FAIL / BLOCKED / NOT VERIFIED). The run REFUSES to touch a real node without both owner approval references:
 *
 *   mode `simulated`  every row runs over the in-memory node and fake node port; every row is labelled SIMULATED; no row can be LIVE-VERIFIED
 *   mode `real`       needs HG-05:<id> (the node) AND HG-06:<id> (panel access), a usable staging target record, a real node port and a real artifact transport. Anything missing:
 *                     all twelve rows are BLOCKED with the exact reason, nothing is created, exit code 3. A real row is LIVE-VERIFIED only when it passed AND the run has both references.
 *
 * Rows 1, 2, 11, 12 are node-level (`StagingNodePort`: probe, site create/reconcile, isolation probe, teardown); rows 3 to 10 drive the deploy path through the same
 * `HostingTargetPublisher` the product uses, so a pass here exercises the product code, not a copy of it. Row 12's last two facts (node deleted at the provider, bill within the
 * cap) are HUMAN attestations: without them the row is NOT VERIFIED, never PASS.
 */
import type { Artifact, TargetSite } from './ports';
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
} from './targets';
import { syntheticApp, SMOKE_PATHS } from './rehearsal';
import { withReleaseMarker, HG05_REF, HG06_REF } from './live-track';
import { waitUntilHealthy, watchDuringSwitch, recoverToLastGood, halfStates } from './health-check';
import {
  validatePreviewDomain,
  SimulatedDns,
  SimulatedRouting,
  SimulatedTls,
  type PreviewDomainInput,
} from './preview-domain-workflow';
import { planSsl } from './ssl-flow';
import { temporarySubdomain } from './preview-url';

export const CHECKLIST_SCHEMA = 'nuzm.staging-checklist/1';
export type RowStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT VERIFIED';
export type RowLabel = 'SIMULATED' | 'LIVE-VERIFIED' | 'NOT VERIFIED';

export interface ChecklistRowDef {
  n: number;
  key: string;
  title: string;
  /** the pass condition, as written in the plan */
  pass: string;
  /** what drives it */
  via: 'node port' | 'deploy path' | 'preview-domain workflow' | 'human attestation';
}
export const CHECKLIST_ROWS: readonly ChecklistRowDef[] = [
  {
    n: 1,
    key: 'panel_probe',
    title: 'Panel probe',
    pass: 'the node reports hosting.runtime.static; version recorded',
    via: 'node port',
  },
  {
    n: 2,
    key: 'create_site',
    title: 'Create the staging site (account s-<hex>)',
    pass: 'found by findByToken; reconcile after a forced timeout finds it',
    via: 'node port',
  },
  {
    n: 3,
    key: 'upload_release_1',
    title: 'Upload release 1',
    pass: 'hash read back from the node equals the artifact hash',
    via: 'deploy path',
  },
  {
    n: 4,
    key: 'staged_smoke',
    title: 'Staged smoke',
    pass: 'HTTP 200 on /, /about/, /health/ over HTTPS from outside the node',
    via: 'deploy path',
  },
  {
    n: 5,
    key: 'switch',
    title: 'Switch',
    pass: 'current points at release 1; no request sees a half state (probe in a loop during the switch)',
    via: 'deploy path',
  },
  {
    n: 6,
    key: 'docroot_behaviour',
    title: 'Document-root behaviour',
    pass: 'the switched root survives a Hestia rebuild; otherwise record the fallback',
    via: 'node port',
  },
  {
    n: 7,
    key: 'temporary_subdomain',
    title: 'Temporary subdomain',
    pass: 'wildcard certificate valid; the host resolves; console cookies absent (different registrable domain)',
    via: 'preview-domain workflow',
  },
  {
    n: 8,
    key: 'failed_release',
    title: 'Failed release',
    pass: 'a forced 503 on one page leaves release 1 serving and removes the staged upload',
    via: 'deploy path',
  },
  {
    n: 9,
    key: 'cancel',
    title: 'Cancel',
    pass: 'cancelled between stage and switch: live untouched, upload removed',
    via: 'deploy path',
  },
  {
    n: 10,
    key: 'rollback',
    title: 'Rollback',
    pass: 'switch back to release 1 without re-upload; smoke passes',
    via: 'deploy path',
  },
  {
    n: 11,
    key: 'isolation',
    title: 'Isolation',
    pass: "a second synthetic site on the node cannot read or write the first site's files",
    via: 'node port',
  },
  {
    n: 12,
    key: 'teardown',
    title: 'Teardown',
    pass: 'site, account and node deleted; verifyWipe reports nothing left; the bill matches the cap',
    via: 'human attestation',
  },
];

/** What the node-level rows need from the hosting side. A real implementation is written in the hosting wiring (HG-05/HG-06); `SimulatedNodePort` below is the stand-in. */
export interface StagingNodePort {
  /** row 1 */
  probe(): Promise<{ runtimes: string[]; panelVersion: string | null }>;
  /** row 2: create the site; when `forceTimeout` the call returns an UNCERTAIN result after the effect happened (reconcile-before-retry) */
  createSite(
    token: string,
    opts: { forceTimeout: boolean },
  ): Promise<{ outcome: 'created' | 'uncertain' }>;
  /** row 2: look the site up by its token-derived name; `null` = provably absent */
  findByToken(token: string): Promise<{ siteName: string } | null>;
  /** the site the deploy rows run on (after `createSite`) */
  target(token: string): TargetSite;
  /** row 6: ask the node to rebuild the domain (Hestia `v-rebuild-web-domain`), as an SSL issue or a domain change would */
  rebuildDomain(site: TargetSite): Promise<void>;
  /** row 11: create a second site and try to read and write the first site's files as that site's own account */
  isolationProbe(
    first: TargetSite,
  ): Promise<{ readBlocked: boolean; writeBlocked: boolean; secondSite: TargetSite }>;
  /** row 12: delete the staging sites through the adapter and run `verifyWipe` */
  teardown(sites: TargetSite[]): Promise<{
    filesRemaining: number;
    usersRemaining: number;
    vhostsRemaining: number;
    certificatesRemaining: number;
  }>;
}

export interface HumanAttestations {
  /** the node was deleted at the provider and the provider console shows no running resource */
  nodeDeletedAtProvider: boolean;
  /** the provider bill is at or below the approved cap */
  billWithinCap: boolean;
  /** who attested and the date (a name or role, never a secret) */
  attestedBy: string;
}

export interface ChecklistInput {
  mode?: 'simulated' | 'real';
  target?: StagingTarget;
  hg05Ref?: string | null;
  hg06Ref?: string | null;
  node?: StagingNodePort;
  transport?: ArtifactTransport;
  ops?: HostingSiteOps;
  /** preview domain workflow inputs (real ports in a real run) */
  previewDomain?: Omit<PreviewDomainInput, 'origin' | 'previewDomain'>;
  attestations?: HumanAttestations | null;
  artifact?: Artifact;
  protectedDomains?: readonly string[];
  /** rows to run (default all); a row that needs an earlier one still runs it */
  only?: number[];
  now?: () => Date;
  /** health policy delay (tests inject 0) */
  sleep?: (ms: number) => Promise<void>;
}

export interface RowResult {
  n: number;
  key: string;
  title: string;
  status: RowStatus;
  label: RowLabel;
  detail: string;
  /** what is needed for a BLOCKED / NOT VERIFIED row */
  needs: string[];
  at: string;
}
export interface ChecklistRecord {
  schema: typeof CHECKLIST_SCHEMA;
  mode: 'simulated' | 'real';
  /** PASS only if every row PASSed; BLOCKED when the gate refused; FAIL if any row failed; NOT VERIFIED when nothing failed but something is unproven */
  status: 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT VERIFIED';
  target: {
    id: string;
    provider: string;
    region: string;
    previewDomain: string | null;
    hg05Ref: string | null;
    hg06Ref: string | null;
  };
  rows: RowResult[];
  timestamps: { startedAt: string; finishedAt: string };
  conclusion: string;
}

const SITE_TOKEN = 'staging-checklist-site-1';
/** SIMULATED names only (`.test` is reserved, RFC 6761): two different registrable domains, so the ADR-060 separation holds in the dry run */
const SIM_PREVIEW = 'previews.pv-sim.test';
const SIM_CONSOLE = 'console.nuzm-sim.test';

export async function runStagingChecklist(input: ChecklistInput): Promise<ChecklistRecord> {
  const mode = input.mode ?? 'simulated';
  const now = input.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const target = input.target ?? SIMULATED_STAGING_TARGET;
  const want = new Set(input.only ?? CHECKLIST_ROWS.map((r) => r.n));
  const rec: ChecklistRecord = {
    schema: CHECKLIST_SCHEMA,
    mode,
    status: 'PASS',
    target: {
      id: target.id,
      provider: target.provider,
      region: target.region,
      previewDomain: target.previewDomain,
      hg05Ref: input.hg05Ref ?? null,
      hg06Ref: input.hg06Ref ?? null,
    },
    rows: [],
    timestamps: { startedAt, finishedAt: startedAt },
    conclusion: '',
  };

  /* ---------- the gate (real mode) ---------- */
  const blockAll = (why: string, needs: string[]) => {
    for (const d of CHECKLIST_ROWS)
      if (want.has(d.n))
        rec.rows.push({
          n: d.n,
          key: d.key,
          title: d.title,
          status: 'BLOCKED',
          label: 'NOT VERIFIED',
          detail: why,
          needs,
          at: now().toISOString(),
        });
    rec.status = 'BLOCKED';
    rec.conclusion = `BLOCKED: ${why} Nothing was created, switched or deleted.`;
    rec.timestamps.finishedAt = now().toISOString();
    return rec;
  };
  if (mode === 'real') {
    try {
      if (!input.hg05Ref || !HG05_REF.test(input.hg05Ref))
        throw new StagingTargetRefused(
          'approval_missing',
          'a real run needs the owner approval reference HG-05:<id> (the node).',
        );
      if (!input.hg06Ref || !HG06_REF.test(input.hg06Ref))
        throw new StagingTargetRefused(
          'approval_missing',
          'a real run needs the owner approval reference HG-06:<id> (the panel access).',
        );
      assertStagingTargetUsable({ ...target, approvalRef: input.hg05Ref }, 'website');
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return blockAll(m.endsWith('.') ? m : `${m}.`, [
        'HG-05 and HG-06 approval references',
        'a staging target record that passes the target gate',
      ]);
    }
    if (!input.node)
      return blockAll(
        'no real node port exists: the hosting-side implementation (panel probe, site create, isolation, teardown) is not wired.',
        [
          'HG-05: a non-production node',
          'HG-06: the panel key in the vault',
          'a StagingNodePort implementation over HestiaHostingAdapter',
        ],
      );
    if (
      !input.transport ||
      input.transport instanceof UnavailableArtifactTransport ||
      input.transport.simulated
    )
      return blockAll(
        'no real artifact transport exists: HOST-TRANSPORT is not provided or the file manager is not connected.',
        [
          'HOST-TRANSPORT decision and implementation',
          'the docroot switch decision (v-change-web-domain-docroot allow-list)',
          'HG-05/HG-06',
        ],
      );
  }

  const simulated = mode === 'simulated';
  const node: StagingNodePort = input.node ?? new SimulatedNodePort();
  const transport: ArtifactTransport = input.transport ?? new InMemoryArtifactTransport();
  const ops: HostingSiteOps = input.ops ?? new InMemoryHostingSiteOps();
  const protectedDomains = input.protectedDomains ?? [];
  const sleep = input.sleep ?? (async () => undefined);
  const live = (pass: boolean): RowLabel =>
    simulated ? 'SIMULATED' : pass ? 'LIVE-VERIFIED' : 'NOT VERIFIED';

  const done = new Set<number>();
  const record = (n: number, status: RowStatus, detail: string, needs: string[] = []) => {
    const d = CHECKLIST_ROWS.find((r) => r.n === n)!;
    rec.rows.push({
      n,
      key: d.key,
      title: d.title,
      status,
      label: status === 'PASS' ? live(true) : simulated ? 'SIMULATED' : 'NOT VERIFIED',
      detail,
      needs,
      at: now().toISOString(),
    });
    done.add(n);
    return status;
  };
  const guarded = async (
    n: number,
    fn: () => Promise<{ status: RowStatus; detail: string; needs?: string[] }>,
  ) => {
    if (!want.has(n)) return;
    try {
      const r = await fn();
      record(n, r.status, r.detail, r.needs ?? []);
    } catch (e) {
      record(n, 'FAIL', e instanceof Error ? e.message : String(e));
    }
  };

  const art1: Artifact = input.artifact ?? syntheticApp(1);
  const art2 = withReleaseMarker(art1, 2);
  const rid = (k: string) => `chk-${k}-${art1.hash.slice(0, 8)}`;
  let site: TargetSite | null = null;
  const publisher = () =>
    new HostingTargetPublisher(
      ops,
      transport,
      simulated ? SIMULATED_STAGING_TARGET : { ...target, approvalRef: input.hg05Ref ?? null },
      {
        previewDomain: simulated ? null : target.previewDomain,
        protectedDomains,
        ...(simulated ? {} : { tagKey: 'staging-checklist' }),
      },
    );
  const probeLive = (s: TargetSite) => (path: string) =>
    transport.probe(s, 'live', path).then((r) => r.status);

  // 1 panel probe
  await guarded(1, async () => {
    const p = await node.probe();
    const ok = p.runtimes.includes('static');
    return {
      status: ok ? 'PASS' : 'FAIL',
      detail: ok
        ? `runtime static reported; panel version ${p.panelVersion ?? 'not reported'}`
        : `the node did not report the static runtime (reported: ${p.runtimes.join(', ') || 'none'})`,
    };
  });

  // 2 create the site, force a timeout, reconcile
  await guarded(2, async () => {
    const c = await node.createSite(SITE_TOKEN, { forceTimeout: true });
    if (c.outcome !== 'uncertain' && c.outcome !== 'created')
      throw new Error('unexpected create outcome');
    const found = await node.findByToken(SITE_TOKEN); // reconcile BEFORE any retry
    if (!found)
      return {
        status: 'FAIL',
        detail:
          'after the forced timeout the site was not found: reconcile-before-retry cannot establish what happened',
      };
    site = node.target(SITE_TOKEN);
    return {
      status: 'PASS',
      detail: `site ${found.siteName} found by token after a ${c.outcome} create`,
    };
  });
  if (
    !site &&
    (want.has(3) ||
      want.has(4) ||
      want.has(5) ||
      want.has(6) ||
      want.has(8) ||
      want.has(9) ||
      want.has(10) ||
      want.has(11) ||
      want.has(12))
  ) {
    try {
      if ((await node.findByToken(SITE_TOKEN)) === null)
        await node.createSite(SITE_TOKEN, { forceTimeout: false });
      site = node.target(SITE_TOKEN);
    } catch {
      site = null;
    }
  }

  const pub = publisher();
  // 3 upload release 1 (hash read back from the node)
  await guarded(3, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    const st = await pub.stage(site, art1, rid('r1'));
    const back = await transport.readReleaseHash(site, st.stagingRef);
    return back === art1.hash
      ? {
          status: 'PASS',
          detail: `hash read back from the node equals the artifact hash (${art1.hash.slice(0, 12)}…)`,
        }
      : {
          status: 'FAIL',
          detail: 'the hash read back from the node differs from the artifact hash',
        };
  });
  // 4 staged smoke
  await guarded(4, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    if (!(await transport.hasRelease(site, rid('r1')))) await pub.stage(site, art1, rid('r1'));
    const sm = await pub.smoke(site, 'staged', rid('r1'), SMOKE_PATHS);
    return sm.ok
      ? { status: 'PASS', detail: `200 on ${SMOKE_PATHS.join(', ')} (tls ${String(sm.tls)})` }
      : {
          status: 'FAIL',
          detail: `not all pages answered 200: ${sm.results.map((r) => `${r.path}=${r.status}`).join(', ')}`,
        };
  });
  // 5 switch with a probe loop running during the switch
  await guarded(5, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    if (!(await transport.hasRelease(site, rid('r1')))) await pub.stage(site, art1, rid('r1'));
    const w = await watchDuringSwitch(
      probeLive(site),
      async () => {
        await pub.activate(site!, rid('r1'));
      },
      { path: '/', parallel: 4, perWorker: 20 },
    );
    const cur = await transport.currentRelease(site);
    const verdict = await waitUntilHealthy(
      probeLive(site),
      { paths: SMOKE_PATHS, attempts: 3, delayMs: 0, requiredConsecutive: 2 },
      sleep,
    );
    const half = halfStates(w.sequence);
    if (cur !== rid('r1'))
      return { status: 'FAIL', detail: `current is ${cur ?? 'nothing'}, not release 1` };
    if (!verdict.healthy) return { status: 'FAIL', detail: verdict.reason };
    if (half.length > 0)
      return {
        status: 'FAIL',
        detail: `${half.length} request(s) saw a half state during the switch (${half.slice(0, 3).join(', ')})`,
      };
    return {
      status: 'PASS',
      detail: `current is release 1; ${w.samples} requests during the switch, none a half state (404 before the first switch is expected); ${verdict.reason}`,
    };
  });
  // 6 document-root behaviour survives a rebuild
  await guarded(6, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    const before = await transport.currentRelease(site);
    await node.rebuildDomain(site);
    const after = await transport.currentRelease(site);
    return before !== null && before === after
      ? { status: 'PASS', detail: 'the served release is unchanged after a domain rebuild' }
      : {
          status: 'FAIL',
          detail: `the served release changed from ${before ?? 'none'} to ${after ?? 'none'} after a rebuild: record the fallback (rename swap) in the evidence`,
        };
  });
  // 7 temporary subdomain: wildcard DNS/TLS/routing/cookies
  await guarded(7, async () => {
    const pd = input.previewDomain;
    const dom = await validatePreviewDomain({
      previewDomain: simulated ? SIM_PREVIEW : target.previewDomain,
      protectedDomains: simulated ? [SIM_CONSOLE] : protectedDomains,
      ...(pd ?? {}),
      ...(simulated && !pd
        ? {
            nodeAddresses: ['203.0.113.10'],
            dns: new SimulatedDns({ wildcardFor: SIM_PREVIEW, address: '203.0.113.10' }),
            tls: new SimulatedTls({
              names: [`*.${SIM_PREVIEW}`],
              notAfter: new Date(now().getTime() + 80 * 86_400_000).toISOString(),
              trusted: true,
            }),
            routing: new SimulatedRouting(
              new Set([
                temporarySubdomain({
                  siteName: 'staging',
                  deploymentId: rid('r1'),
                  previewDomain: SIM_PREVIEW,
                  protectedDomains: [SIM_CONSOLE],
                }).host,
              ]),
            ),
            sample: { siteName: 'staging', deploymentId: rid('r1') },
          }
        : {}),
      origin: simulated ? 'SIMULATED' : 'REAL',
      now,
    });
    const bad = dom.checks.filter((c) => c.status === 'FAIL');
    const unk = dom.checks.filter((c) => c.status === 'NOT VERIFIED');
    if (bad.length)
      return { status: 'FAIL', detail: bad.map((c) => `${c.id}: ${c.detail}`).join('; ') };
    if (unk.length)
      return {
        status: 'NOT VERIFIED',
        detail: unk.map((c) => `${c.id}: ${c.detail}`).join('; '),
        needs: unk.flatMap((c) => c.needs),
      };
    // an SSL plan for the temporary host must not need a certificate of its own (the wildcard covers it)
    const plan = planSsl({
      hostKind: 'temporary',
      host: `x.${(simulated ? SIM_PREVIEW : target.previewDomain) ?? 'unset.invalid'}`,
      simulated,
      hg06Approved: !simulated && !!input.hg06Ref,
      dnsVerified: true,
      cert: { state: 'none', notAfter: null, failures: 0 },
      now: now().toISOString(),
    });
    if (plan.state !== 'not_required')
      return {
        status: 'FAIL',
        detail: `the ssl plan for a temporary host is ${plan.state}, expected not_required (the wildcard covers it)`,
      };
    return {
      status: 'PASS',
      detail: `${dom.checks.length} domain checks passed; ssl plan for a temporary host: ${plan.state}`,
    };
  });
  // 8 failed release: bad health leaves release 1 serving, staged upload removed
  await guarded(8, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    const live1 = await transport.currentRelease(site);
    if (live1 !== rid('r1')) {
      if (!(await transport.hasRelease(site, rid('r1')))) await pub.stage(site, art1, rid('r1'));
      await pub.activate(site, rid('r1'));
    }
    const bad = withReleaseMarker(art1, 99);
    await pub.stage(site, bad, rid('bad'));
    // the deploy path discards a release whose staged smoke fails; a real node answers 503 for a real bad page, the simulation forces it
    const sm = await pub.smoke(
      site,
      'staged',
      rid('bad'),
      simulated ? ['/', '/definitely-missing/'] : SMOKE_PATHS,
    );
    if (sm.ok && !simulated)
      return {
        status: 'NOT VERIFIED',
        detail:
          'the deliberately bad release was not detected as bad: this run did not force a 503',
        needs: ['a node-side way to force a 503 on one page of the staged release'],
      };
    const rep = await recoverToLastGood(pub, site, art1, rid('bad'));
    const served = await pub.activeHash(site);
    const gone = !(await transport.hasRelease(site, rid('bad')));
    return served === art1.hash && gone && rep.action !== 'failed'
      ? {
          status: 'PASS',
          detail: `release 1 still serving (${rep.detail}); the bad staged release is removed`,
        }
      : {
          status: 'FAIL',
          detail: `served ${served?.slice(0, 12) ?? 'nothing'}, bad release removed: ${gone}; ${rep.detail}`,
        };
  });
  // 9 cancel between stage and switch
  await guarded(9, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    const before = await pub.activeHash(site);
    await pub.stage(site, art2, rid('r2'));
    // cancellation at the checkpoint before the switch: discard, never activate
    await pub.discard(site, rid('r2'));
    const after = await pub.activeHash(site);
    const gone = !(await transport.hasRelease(site, rid('r2')));
    return before === after && gone
      ? { status: 'PASS', detail: 'live untouched; the staged upload is removed' }
      : {
          status: 'FAIL',
          detail: `live ${before === after ? 'unchanged' : 'CHANGED'}; staged upload removed: ${gone}`,
        };
  });
  // 10 release 2, then rollback to release 1 without re-upload
  await guarded(10, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    if (!(await transport.hasRelease(site, rid('r1'))))
      throw new Error('release 1 is not on the node: cannot test a rollback without re-upload');
    await pub.stage(site, art2, rid('r2'));
    await pub.activate(site, rid('r2'));
    if ((await pub.activeHash(site)) !== art2.hash)
      return { status: 'FAIL', detail: 'release 2 is not what the node serves' };
    const puts = transport instanceof InMemoryArtifactTransport ? transport.puts : null;
    await pub.restore(site, art1); // switches to the retained release when it is still on the node
    const served = await pub.activeHash(site);
    const reuploaded =
      puts !== null && transport instanceof InMemoryArtifactTransport && transport.puts > puts;
    const sm = await pub.smoke(site, 'live', null, SMOKE_PATHS);
    if (served !== art1.hash)
      return {
        status: 'FAIL',
        detail: 'the node does not serve release 1 byte for byte after the rollback',
      };
    if (reuploaded)
      return {
        status: 'FAIL',
        detail: 'the rollback re-uploaded instead of switching to the retained release',
      };
    return sm.ok
      ? { status: 'PASS', detail: 'release 1 served again (hash equal), no re-upload, smoke 200' }
      : { status: 'FAIL', detail: 'smoke failed after the rollback' };
  });
  // 11 isolation
  await guarded(11, async () => {
    if (!site) return { status: 'BLOCKED', detail: 'no staging site', needs: ['row 2'] };
    const r = await node.isolationProbe(site);
    return r.readBlocked && r.writeBlocked
      ? {
          status: 'PASS',
          detail: "the second site could neither read nor write the first site's files",
        }
      : {
          status: 'FAIL',
          detail: `read blocked: ${r.readBlocked}, write blocked: ${r.writeBlocked}`,
        };
  });
  // 12 teardown (+ human attestations)
  await guarded(12, async () => {
    const sites: TargetSite[] = site ? [site] : [];
    const w = await node.teardown(sites);
    const left = w.filesRemaining + w.usersRemaining + w.vhostsRemaining + w.certificatesRemaining;
    if (left > 0) return { status: 'FAIL', detail: `verifyWipe reports ${left} item(s) left` };
    const a = input.attestations;
    if (!a)
      return {
        status: 'NOT VERIFIED',
        detail:
          'verifyWipe is clean; the node deletion at the provider and the bill are human facts nobody attested',
        needs: [
          'an attestation that the node is deleted at the provider and the bill is within the cap',
        ],
      };
    if (!a.nodeDeletedAtProvider || !a.billWithinCap)
      return {
        status: 'FAIL',
        detail: `attestation by ${a.attestedBy}: node deleted ${a.nodeDeletedAtProvider}, bill within cap ${a.billWithinCap}`,
      };
    return {
      status: 'PASS',
      detail: `verifyWipe clean; node deleted and bill within cap, attested by ${a.attestedBy}`,
    };
  });

  rec.rows.sort((a, b) => a.n - b.n);
  rec.timestamps.finishedAt = now().toISOString();
  const st = rec.rows.map((r) => r.status);
  rec.status = st.includes('FAIL')
    ? 'FAIL'
    : st.includes('BLOCKED')
      ? 'BLOCKED'
      : st.includes('NOT VERIFIED')
        ? 'NOT VERIFIED'
        : 'PASS';
  const pass = st.filter((s) => s === 'PASS').length;
  rec.conclusion = simulated
    ? `SIMULATED run over stand-ins: ${pass}/${rec.rows.length} rows PASS. Nothing here is LIVE-VERIFIED and none of it proves what a real node does.`
    : `REAL run with ${rec.target.hg05Ref} and ${rec.target.hg06Ref}: ${pass}/${rec.rows.length} rows PASS.`;
  return rec;
}

/** Evidence check: may this record be filed as LIVE-VERIFIED? Only a real run with both references in which every row PASSed and none is labelled simulated. */
export function checklistLiveEligible(r: ChecklistRecord): {
  eligible: boolean;
  problems: string[];
} {
  const p: string[] = [];
  if (r.schema !== CHECKLIST_SCHEMA) p.push('wrong schema');
  if (r.mode !== 'real') p.push('not a real run');
  if (!r.target.hg05Ref || !HG05_REF.test(r.target.hg05Ref)) p.push('HG-05 reference missing');
  if (!r.target.hg06Ref || !HG06_REF.test(r.target.hg06Ref)) p.push('HG-06 reference missing');
  if (r.rows.length !== CHECKLIST_ROWS.length) p.push('not all twelve rows are present');
  for (const x of r.rows) {
    if (x.status !== 'PASS') p.push(`row ${x.n} is ${x.status}`);
    if (x.label !== 'LIVE-VERIFIED') p.push(`row ${x.n} is labelled ${x.label}`);
  }
  return { eligible: p.length === 0, problems: p };
}

/* ---------- the SIMULATED node port ---------- */
export class SimulatedNodePort implements StagingNodePort {
  private readonly sites = new Map<string, TargetSite>();
  /** a node that did not keep the docroot after a rebuild (to prove row 6 can fail) */
  forgetDocrootOnRebuild = false;
  /** a node whose accounts can read each other (to prove row 11 can fail) */
  leakyIsolation = false;
  leftoverFiles = 0;
  async probe() {
    return { runtimes: ['static', 'php:8.3'], panelVersion: 'simulated' };
  }
  async createSite(token: string, opts: { forceTimeout: boolean }) {
    this.sites.set(token, {
      id: `sim-${token}`,
      name: `s-${token.replace(/[^a-z0-9]/g, '').slice(0, 20)}`,
      status: 'active',
      runtime: 'static',
      dataRegion: 'local',
      domain: null,
    });
    return { outcome: opts.forceTimeout ? ('uncertain' as const) : ('created' as const) };
  }
  async findByToken(token: string) {
    const s = this.sites.get(token);
    return s ? { siteName: s.name } : null;
  }
  target(token: string) {
    const s = this.sites.get(token);
    if (!s) throw new Error('no such site');
    return s;
  }
  async rebuildDomain() {
    if (this.forgetDocrootOnRebuild)
      throw new Error('simulated: the rebuild reset the document root');
  }
  async isolationProbe(first: TargetSite) {
    const second: TargetSite = { ...first, id: `${first.id}-2`, name: `${first.name}2` };
    this.sites.set('second', second);
    return {
      readBlocked: !this.leakyIsolation,
      writeBlocked: !this.leakyIsolation,
      secondSite: second,
    };
  }
  async teardown() {
    this.sites.clear();
    return {
      filesRemaining: this.leftoverFiles,
      usersRemaining: 0,
      vhostsRemaining: 0,
      certificatesRemaining: 0,
    };
  }
}
