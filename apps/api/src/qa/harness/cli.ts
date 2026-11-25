/**
 * P3-S08 qualification harness CLI.
 *   tsx src/qa/harness/cli.ts                         SIMULATED run of every scenario; records to <out> (default .dev-data/qualification/simulated), nothing real is touched
 *   tsx src/qa/harness/cli.ts --mode live             stops at the FIRST scenario with a missing approval / external blocker / predecessor, and prints the exact blocker (exit 3)
 *   tsx src/qa/harness/cli.ts --plan                  prints every scenario's blockers for a live run (no stop, nothing run)
 *   options: --out <dir> · --only <id,id> · --reset (forget the resume state)
 * Exit: 0 all ran (simulated) / all live scenarios ran · 1 a scenario failed or its record was rejected · 3 stopped at a blocker.
 */
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadApprovals } from '../evidence/approvals';
import { repoRoot } from '../evidence/verify';
import { LIVE_DRIVERS } from './drivers';
import { blockersOf, renderReport, runHarness, type Mode } from './runner';
import { SCENARIOS, isOfflineOnly } from './scenarios';

async function main(argv: string[]): Promise<number> {
  const get = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
  const root = repoRoot();
  if (argv.includes('--plan')) {
    const ap = loadApprovals(root);
    for (const s of SCENARIOS.filter((x) => !isOfflineOnly(x))) {
      const b = blockersOf(s, ap, new Set(), LIVE_DRIVERS);
      process.stdout.write(
        `${s.id}  (${s.owner})\n  ${b.length ? b.join('\n  ') : 'no blocker'}\n`,
      );
    }
    return 0;
  }
  const mode = (get('--mode') ?? 'simulated') as Mode;
  if (mode !== 'simulated' && mode !== 'live') {
    process.stderr.write('--mode must be simulated or live\n');
    return 2;
  }
  const outDir = resolve(get('--out') ?? join(root, '.dev-data/qualification', mode));
  if (argv.includes('--reset')) rmSync(outDir, { recursive: true, force: true });
  const only = get('--only')?.split(',');
  const r = await runHarness({ mode, outDir, root, ...(only ? { only } : {}) });
  process.stdout.write(renderReport(r) + `\n\nrecords: ${outDir}\n`);
  return r.exitCode;
}
void main(process.argv.slice(2)).then((c) => process.exit(c));
