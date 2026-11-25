/**
 * Tracks F and G — `npx tsx apps/api/src/modules/deploy/internal/live-track.cli.ts <preview|deploy|validate> [evidence.json]`
 *
 *   preview   track F: stage an application build on the target, smoke it at its temporary subdomain, discard it (live never switched)
 *   deploy    track G: release 1 → switch → release 2 → switch → rollback → smoke
 *   validate  read an evidence JSON and say whether it is valid and whether it may be recorded as LIVE-VERIFIED
 *
 * Environment (no secret is read, printed or stored; there is none to give):
 *   STAGING_MODE            simulated (default) | real
 *   STAGING_TARGET_FILE     real: path of the staging target record (JSON: id, kind, provider, verification, region, previewDomain, approvalRef, evidenceRef)
 *   STAGING_HG05_REF        real: owner approval reference for the node, HG-05:<id>
 *   STAGING_HG06_REF        real: owner approval reference for the panel access, HG-06:<id>
 *   STAGING_PROTECTED_DOMAINS  comma list: console, admin, API and marketing domains (ADR-060: the preview domain must not share a registrable domain with them)
 *   STAGING_APP_DIR         optional: a built static application directory to use instead of the synthetic app (symlink-free, bounded)
 *   STAGING_EVIDENCE_OUT    optional: write the evidence record here
 *
 * Exit codes: 0 PASS (or a valid evidence file) · 1 FAIL / invalid evidence · 3 BLOCKED (a gate refused: nothing was deployed).
 * Real mode ends BLOCKED today: no artifact upload path to a hosting node exists yet.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { ArtifactDirRefused, loadArtifactFromDir } from './artifact-dir';
import {
  parseStagingTargetRecord,
  runLiveTrack,
  validateLiveEvidence,
  type LiveEvidenceRecord,
  type Track,
} from './live-track';
import type { StagingTarget } from './targets';

async function main(): Promise<number> {
  const cmd = process.argv[2];
  if (cmd === 'validate') {
    const file = process.argv[3];
    if (!file) {
      process.stderr.write('usage: live-track.cli.ts validate <evidence.json>\n');
      return 2;
    }
    const check = validateLiveEvidence(
      JSON.parse(readFileSync(file, 'utf8')) as LiveEvidenceRecord,
    );
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    return check.valid ? 0 : 1;
  }
  if (cmd !== 'preview' && cmd !== 'deploy') {
    process.stderr.write('usage: live-track.cli.ts <preview|deploy|validate> [evidence.json]\n');
    return 2;
  }
  const track: Track = cmd === 'preview' ? 'F' : 'G';
  const mode = process.env.STAGING_MODE === 'real' ? 'real' : 'simulated';
  let target: StagingTarget | undefined;
  if (mode === 'real') {
    const f = process.env.STAGING_TARGET_FILE;
    if (!f) {
      process.stderr.write(
        'BLOCKED: a real run needs STAGING_TARGET_FILE (the staging target record). Nothing was deployed.\n',
      );
      return 3;
    }
    const parsed = parseStagingTargetRecord(readFileSync(f, 'utf8'));
    if (!parsed.ok) {
      process.stderr.write(
        `BLOCKED: invalid staging target record: ${parsed.problems.join('; ')}. Nothing was deployed.\n`,
      );
      return 3;
    }
    target = parsed.target;
  }
  let artifact;
  try {
    if (process.env.STAGING_APP_DIR) artifact = loadArtifactFromDir(process.env.STAGING_APP_DIR);
  } catch (e) {
    if (e instanceof ArtifactDirRefused) {
      process.stderr.write(`REFUSED: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const record = await runLiveTrack({
    track,
    mode,
    ...(target ? { target } : {}),
    hg05Ref: process.env.STAGING_HG05_REF ?? null,
    hg06Ref: process.env.STAGING_HG06_REF ?? null,
    ...(artifact ? { artifact } : {}),
    protectedDomains: (process.env.STAGING_PROTECTED_DOMAINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // real mode: no transport is passed because none exists yet; the run reports BLOCKED with that reason
  });
  const json = JSON.stringify(record, null, 2);
  if (process.env.STAGING_EVIDENCE_OUT)
    writeFileSync(process.env.STAGING_EVIDENCE_OUT, `${json}\n`);
  process.stdout.write(`${json}\n`);
  return record.status === 'PASS' ? 0 : record.status === 'BLOCKED' ? 3 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
