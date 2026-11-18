/**
 * Usage: BASE_URL=https://staging… SESSION_COOKIE='nuzm_session=…' CSRF=… ORG_ID=… pnpm --filter @nuzm/api exec tsx src/ops/load/cli.ts <scenario-id> [--declared]
 * Writes the JSON result to docs/reports/load/<id>-<timestamp>.json. Without --declared it runs the SMOKE size, which is labelled and never counts as the declared-scale evidence.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from './runner';
import { SCENARIOS } from './scenarios';

async function main() {
  const [id, ...flags] = process.argv.slice(2);
  const def = SCENARIOS.find((s) => s.id === id);
  if (!def) throw new Error(`unknown scenario. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  if (def.status === 'blocked' || !def.build) {
    console.log(`BLOCKED: ${def.blockedBy}`);
    process.exit(2);
  }
  const base = process.env.BASE_URL;
  if (!base) throw new Error('BASE_URL is required (a staging URL; never production)');
  if (/prod|\.nuzm\.(sa|com)$/i.test(new URL(base).hostname))
    throw new Error('refusing to load-test something that looks like production');
  const cfg = def.build(
    base,
    {
      cookie: process.env.SESSION_COOKIE ?? '',
      csrf: process.env.CSRF ?? '',
      orgId: process.env.ORG_ID ?? '',
    },
    flags.includes('--declared') ? 'declared' : 'smoke',
  );
  const r = await runScenario(cfg);
  const dir = join(__dirname, '../../../../../docs/reports/load');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}-${r.scale}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(r, null, 2));
  console.log(
    JSON.stringify({ ...r, byRequest: undefined }, null, 2),
    `\nwritten ${file}\n${r.scale === 'smoke' ? 'SMOKE run: not evidence for the declared scale.' : ''}`,
  );
  process.exit(r.pass ? 0 : 1);
}
void main();
