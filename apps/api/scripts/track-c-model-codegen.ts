/**
 * `tsx scripts/track-c-model-codegen.ts [--live --evidence <file>] [--json]` — Track C. Without `--live` it runs SIMULATED (scripted model / mock execution, offline, no network) and prints the evidence
 * record. With `--live` it REFUSES (exit 2) unless the approval evidence file is complete, and even then (exit 3) it calls nothing: this repository wires no provider and no runtime into
 * a script. See `internal/lifecycle/tracks.ts` for the approvals required and the record format.
 */
// developer tools that drive the module's own harness, not consumers of its public API
/* eslint-disable no-restricted-imports */
import { readFileSync } from 'node:fs';
import {
  LIVE_REFUSAL,
  checkApprovalEvidence,
  simulateTrackC,
} from '../src/modules/appbuilder/internal/lifecycle/tracks';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--live')) {
    const i = args.indexOf('--evidence');
    let raw: unknown;
    try {
      raw = i >= 0 && args[i + 1] ? JSON.parse(readFileSync(args[i + 1]!, 'utf8')) : null;
    } catch {
      raw = null;
    }
    const check = checkApprovalEvidence('C', raw);
    process.stderr.write(LIVE_REFUSAL('C', check) + '\n');
    process.exit(check.ok ? 3 : 2);
  }
  const rec = await simulateTrackC();
  process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
  if (rec.lifecycleStatus !== 'waiting_approval') process.exit(1);
}
void main();
