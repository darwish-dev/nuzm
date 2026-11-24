/**
 * `npx tsx apps/api/src/modules/deploy/internal/rehearsal.cli.ts` — staging rehearsal of a synthetic app (see rehearsal.ts and docs/parallel/STAGING-DEPLOYMENT-PLAN.md §6).
 *
 * Environment (no secrets are read or printed; there are none to give):
 *   STAGING_MODE              simulated (default) | real
 *   STAGING_TARGET_ID         real mode: the registered target id, e.g. hosting:staging-1
 *   STAGING_APPROVAL_REF      real mode: the owner's recorded HG-05 approval reference
 *   STAGING_PREVIEW_DOMAIN    real mode: the isolated preview domain (ADR-060)
 *   STAGING_PROTECTED_DOMAINS comma list: console, admin, API and marketing domains the preview domain must not share a registrable domain with
 *   STAGING_REGION            real mode: data region of the node
 *   STAGING_EVIDENCE_OUT      optional path: write the JSON evidence record there instead of only printing it
 *
 * Exit codes: 0 PASS · 1 FAIL · 3 BLOCKED (a gate refused: nothing was deployed). Real mode ends BLOCKED today because no artifact upload path to a hosting node exists.
 */
import { writeFileSync } from 'node:fs';
import { runStagingRehearsal } from './rehearsal';
import type { StagingTarget } from './targets';

async function main(): Promise<number> {
  const mode = process.env.STAGING_MODE === 'real' ? 'real' : 'simulated';
  const protectedDomains = (process.env.STAGING_PROTECTED_DOMAINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const target: StagingTarget | undefined =
    mode === 'real'
      ? {
          id: process.env.STAGING_TARGET_ID ?? 'hosting:unconfigured',
          kind: 'static_hosting',
          provider: 'hosting_panel',
          verification: 'NOT VERIFIED',
          region: process.env.STAGING_REGION ?? 'unset',
          previewDomain: process.env.STAGING_PREVIEW_DOMAIN || null,
          approvalRef: process.env.STAGING_APPROVAL_REF || null,
          evidenceRef: null,
        }
      : undefined;
  // real mode: no transport is passed because none exists yet; the rehearsal reports BLOCKED with that reason
  const report = await runStagingRehearsal({
    mode,
    ...(target ? { target } : {}),
    protectedDomains,
  });
  const json = JSON.stringify(report, null, 2);
  if (process.env.STAGING_EVIDENCE_OUT)
    writeFileSync(process.env.STAGING_EVIDENCE_OUT, `${json}\n`);
  process.stdout.write(`${json}\n`);
  return report.status === 'PASS' ? 0 : report.status === 'BLOCKED' ? 3 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
