/**
 * `pnpm --filter @nuzm/api qualification:builder [-- --write]` — OFFLINE: drives five synthetic projects through the builder lifecycle over in-memory ports and prints the per-component
 * evidence table. No network, no database, no provider, no process is started. Every row is SIMULATED. `--write` also regenerates
 * `docs/parallel/sessions/PHASE2-05-qualification-evidence.md`. Exit code 1 if any project does not reach the deployment-approval request.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// a developer tool that drives the module's own harness, not a consumer of its public API
// eslint-disable-next-line no-restricted-imports
import {
  renderMarkdown,
  renderText,
  runQualification,
} from '../src/modules/appbuilder/internal/lifecycle/qualification';

async function main() {
  const runs = await runQualification();
  const rows = runs.map((r) => r.row);
  process.stdout.write(renderText(rows) + '\n');
  if (process.argv.includes('--write')) {
    const out = resolve(
      __dirname,
      '../../../docs/parallel/sessions/PHASE2-05-qualification-evidence.md',
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderMarkdown(rows));
    process.stdout.write(`wrote ${out}\n`);
  }
  const bad = runs.filter((r) => r.status !== 'waiting_approval');
  if (bad.length) {
    process.stderr.write(`NOT QUALIFIED: ${bad.map((b) => b.brief.id).join(', ')}\n`);
    process.exit(1);
  }
}
void main();
