import { readFileSync, writeFileSync } from 'node:fs';
import {
  QualificationRefused,
  renderReport,
  runQualification,
  type QualificationMode,
} from './escape-runner';

/**
 * CLI for the escape-suite qualification runner (S-AG6 phase 2). Today only `simulated:<node>` endpoints work.
 *   npx tsx apps/api/src/modules/appbuilder/internal/sandbox/escape-runner.cli.ts --endpoint simulated:node-1 [--mode simulated] [--out report.json]
 *   ... --mode qualify|requalify --endpoint https://... --declaration decl.json [--attestation att.json] --approval HG-10-02-xxx   (needs the node client and an approved staging node)
 * Exit codes: 0 no FAIL; 1 at least one attempt ESCAPED; 2 refused / bad usage.
 */
function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const mode = (arg(argv, 'mode') ?? 'simulated') as QualificationMode;
  const endpoint = arg(argv, 'endpoint');
  if (!endpoint || !['simulated', 'qualify', 'requalify'].includes(mode)) {
    console.error(
      'usage: --endpoint <simulated:node | https://...> [--mode simulated|qualify|requalify] [--declaration f] [--attestation f] [--approval ref] [--out f]',
    );
    return 2;
  }
  try {
    const read = (f?: string) => (f ? (JSON.parse(readFileSync(f, 'utf8')) as unknown) : undefined);
    const report = await runQualification({
      mode,
      endpoint,
      declaration: read(arg(argv, 'declaration')) as never,
      attestation: read(arg(argv, 'attestation')),
      trust: read(arg(argv, 'trust')) as never,
      approvalRef: arg(argv, 'approval'),
      env,
    });
    console.log(renderReport(report));
    const out = arg(argv, 'out');
    if (out) writeFileSync(out, JSON.stringify(report, null, 2));
    return report.totals.fail > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof QualificationRefused) {
      console.error(`REFUSED: ${e.reasons.join(', ')}`);
      return 2;
    }
    throw e;
  }
}
if (require.main === module) void main(process.argv.slice(2)).then((c) => process.exit(c));
