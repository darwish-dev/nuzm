/**
 * The 12 staging checks as one run — `npx tsx apps/api/src/modules/deploy/internal/staging-checklist.cli.ts <run|validate|rows> [evidence.json]`
 *
 *   run       run the checklist (STAGING_MODE=simulated by default: every row SIMULATED; a real run REFUSES without both approval references)
 *   validate  read an evidence JSON and say whether it may be filed as LIVE-VERIFIED
 *   rows      print the twelve rows and their pass conditions
 *
 * Environment (no secret is read, printed or stored; there is none to give):
 *   STAGING_MODE               simulated (default) | real
 *   STAGING_TARGET_FILE        real: the staging target record (JSON, see live-track.cli.ts)
 *   STAGING_HG05_REF           real: HG-05:<id> (the node)        STAGING_HG06_REF  real: HG-06:<id> (the panel access)
 *   STAGING_PROTECTED_DOMAINS  comma list: console, admin, API and marketing domains (ADR-060)
 *   STAGING_ONLY               optional comma list of row numbers, e.g. 3,4,5
 *   STAGING_ATTEST_BY          optional: who attests row 12's human facts (node deleted at the provider, bill within the cap) together with STAGING_ATTEST_NODE_DELETED=yes and STAGING_ATTEST_BILL_OK=yes
 *   STAGING_EVIDENCE_OUT       optional: write the record here
 *
 * Exit codes: 0 no row failed and nothing blocked (PASS or NOT VERIFIED rows are listed) · 1 FAIL / invalid evidence · 3 BLOCKED (a gate refused: nothing was created) · 2 usage.
 * Real mode ends BLOCKED today: no real node port and no real artifact transport are wired (HG-05, HG-06, HOST-TRANSPORT).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseStagingTargetRecord } from './live-track';
import {
  CHECKLIST_ROWS,
  checklistLiveEligible,
  runStagingChecklist,
  type ChecklistRecord,
} from './staging-checklist';
import type { StagingTarget } from './targets';

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === 'rows') {
    for (const r of CHECKLIST_ROWS)
      process.stdout.write(`${r.n}. ${r.title}: ${r.pass} [${r.via}]\n`);
    return 0;
  }
  if (cmd === 'validate') {
    const f = process.argv[3];
    if (!f) {
      process.stderr.write('usage: staging-checklist.cli.ts validate <evidence.json>\n');
      return 2;
    }
    const v = checklistLiveEligible(JSON.parse(readFileSync(f, 'utf8')) as ChecklistRecord);
    process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
    return v.eligible ? 0 : 1;
  }
  if (cmd !== 'run') {
    process.stderr.write('usage: staging-checklist.cli.ts <run|validate|rows> [evidence.json]\n');
    return 2;
  }
  const mode = process.env.STAGING_MODE === 'real' ? 'real' : 'simulated';
  let target: StagingTarget | undefined;
  if (mode === 'real') {
    const f = process.env.STAGING_TARGET_FILE;
    if (!f) {
      process.stderr.write('BLOCKED: a real run needs STAGING_TARGET_FILE. Nothing was created.\n');
      return 3;
    }
    const parsed = parseStagingTargetRecord(readFileSync(f, 'utf8'));
    if (!parsed.ok) {
      process.stderr.write(
        `BLOCKED: invalid staging target record: ${parsed.problems.join('; ')}. Nothing was created.\n`,
      );
      return 3;
    }
    target = parsed.target;
  }
  const only = (process.env.STAGING_ONLY ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
  const rec = await runStagingChecklist({
    mode,
    ...(target ? { target } : {}),
    hg05Ref: process.env.STAGING_HG05_REF ?? null,
    hg06Ref: process.env.STAGING_HG06_REF ?? null,
    protectedDomains: (process.env.STAGING_PROTECTED_DOMAINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ...(only.length ? { only } : {}),
    attestations: process.env.STAGING_ATTEST_BY
      ? {
          attestedBy: process.env.STAGING_ATTEST_BY,
          nodeDeletedAtProvider: process.env.STAGING_ATTEST_NODE_DELETED === 'yes',
          billWithinCap: process.env.STAGING_ATTEST_BILL_OK === 'yes',
        }
      : null,
    // real mode: no node port and no transport are passed because none is wired yet; the run reports BLOCKED with that reason
  });
  const json = JSON.stringify(rec, null, 2);
  if (process.env.STAGING_EVIDENCE_OUT)
    writeFileSync(process.env.STAGING_EVIDENCE_OUT, `${json}\n`);
  process.stdout.write(`${json}\n`);
  return rec.status === 'BLOCKED' ? 3 : rec.status === 'FAIL' ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
