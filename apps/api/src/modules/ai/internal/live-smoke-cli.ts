import { readFileSync, writeFileSync } from 'node:fs';
import { FileDevSecretStore } from '../../../common/secrets';
import { reconcileSavedReport, runSmoke, type SmokeArgs } from './live-smoke';

/**
 * Operator entry point of the real-provider smoke runner (see `live-smoke.ts` for the gates). NOT a package script and never run by CI.
 *
 *   pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/live-smoke-cli.ts \
 *     --vault-ref vault://dev/ai-claude --approval ./approval.json --evidence ./evidence.json [--vendor-usage ./usage.json] [--report ./report.json] [--execute]
 *   pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/live-smoke-cli.ts --reconcile ./report.json --vendor-usage ./usage.json [--tolerance 0] [--report ./report-reconciled.json]
 *
 * Without --execute it is a DRY RUN (nothing is sent). The key is read from the sealed dev vault (SESSION_SEAL_KEY seals it; the key file lives in ./.dev-vault) and is never an
 * argument or an environment variable. Files named here are the operator's, outside the repository: do not commit an approval, an evidence file or a report.
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const json = (p: string | undefined): unknown => {
  if (!p) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

async function main(): Promise<number> {
  // `--reconcile <report.json> --vendor-usage <usage.json>`: arithmetic on two saved files; no gate, no key, no request
  if (arg('reconcile')) {
    const r = reconcileSavedReport(
      json(arg('reconcile')),
      json(arg('vendor-usage')),
      Number(arg('tolerance') ?? 0),
    );
    if (r.kind === 'refused') {
      console.error('REFUSED:');
      for (const p of r.problems) console.error(`  - ${p}`);
      return 2;
    }
    const out = arg('report');
    if (out) writeFileSync(out, JSON.stringify(r.report, null, 2), { mode: 0o600 });
    const c = r.report.checks.find((x) => x.id === 'usage_reconciliation')!;
    console.log(
      `${c.ok && c.ran ? 'PASS' : 'FAIL'}  usage_reconciliation  [${c.evidence}]  ${c.detail}`,
    );
    console.log(`overall: ${r.report.allPassed ? 'all checks passed' : 'NOT all checks passed'}`);
    return r.report.allPassed ? 0 : 1;
  }
  const args: SmokeArgs = {
    execute: process.argv.includes('--execute'),
    provider: arg('provider') ?? 'claude',
    vaultRef: arg('vault-ref'),
    approval: json(arg('approval')),
    evidence: json(arg('evidence')),
    ...(arg('vendor-usage') ? { vendorUsage: json(arg('vendor-usage')) } : {}),
    ...(arg('tolerance') ? { usageToleranceTokens: Number(arg('tolerance')) } : {}),
  };
  const result = await runSmoke(args, {
    env: process.env,
    readKey: async (ref) => {
      const seal = Buffer.from(process.env.SESSION_SEAL_KEY ?? '', 'base64');
      if (seal.length !== 32) throw new Error('SESSION_SEAL_KEY must be 32 bytes, base64-encoded');
      return new FileDevSecretStore(new Uint8Array(seal)).get(ref);
    },
  });
  if (result.kind === 'refused') {
    console.error('REFUSED. Nothing was sent. Problems:');
    for (const p of result.problems) console.error(`  - ${p}`);
    return 2;
  }
  if (result.kind === 'dry_run') {
    console.log(JSON.stringify(result.plan, null, 2));
    return 0;
  }
  const out = arg('report');
  if (out) writeFileSync(out, JSON.stringify(result.report, null, 2), { mode: 0o600 });
  for (const c of result.report.checks)
    console.log(
      `${c.ok && c.ran ? 'PASS' : c.ran ? 'FAIL' : 'NOT RUN'}  ${c.id}  [${c.evidence}]  ${c.detail}`,
    );
  console.log(
    `requests ${result.report.requests}, tokens ${result.report.totalTokens}, cost(nano ${result.report.currency}) ${result.report.costNano}${result.report.stoppedEarly ? `, stopped: ${result.report.stoppedEarly}` : ''}`,
  );
  return result.report.allPassed ? 0 : 1;
}
main().then(
  (c) => process.exit(c),
  () => {
    console.error(
      'the smoke runner failed unexpectedly (no detail is printed: it could carry request data)',
    );
    process.exit(3);
  },
);
