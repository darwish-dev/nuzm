import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { RunRefused, runInRuntime } from './run-in-runtime';

/**
 * CLI for Track D. READS the project's text files (never runs them) and hands them to the runtime port.
 *   npx tsx apps/api/src/modules/appbuilder/internal/sandbox/run-in-runtime.cli.ts --endpoint simulated:node-1 --profile typecheck --project ./some-dir
 *   live (refuses today): --mode live --endpoint https://… --profile … --project … --node-id … --endpoint-id … --attestation att.json --trust keys.json --d21 D-21-… --hg-10-02 HG-10-02-… --adr ADR-… --approval REF (and NUZM_EXECUTION_APPROVED=REF)
 * Exit codes: 0 ran (simulated or live) with a completed outcome; 1 ran but not completed; 2 refused / bad usage.
 */
const arg = (a: string[], n: string) =>
  a.indexOf(`--${n}`) >= 0 ? a[a.indexOf(`--${n}`) + 1] : undefined;
const SKIP = new Set(['node_modules', '.git', 'dist']);
function readProject(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isSymbolicLink() || SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (out.size < 500 && statSync(p).size <= 1_000_000)
        out.set(relative(dir, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const endpoint = arg(argv, 'endpoint');
  const profile = arg(argv, 'profile');
  const mode = (arg(argv, 'mode') ?? 'simulated') as 'simulated' | 'live';
  if (!endpoint || !profile || !['simulated', 'live'].includes(mode)) {
    console.error(
      'usage: --endpoint <simulated:node|https://…> --profile <typecheck|unit-tests|build|install-deps|run-script> [--project dir] [--mode simulated|live] …',
    );
    return 2;
  }
  try {
    const read = (f?: string) => (f ? (JSON.parse(readFileSync(f, 'utf8')) as unknown) : undefined);
    const project = arg(argv, 'project');
    const script = arg(argv, 'script');
    const r = await runInRuntime({
      mode,
      endpoint,
      profile,
      params: script ? { script } : undefined,
      projectScripts: script ? [script] : [],
      files: project
        ? readProject(project)
        : new Map([['package.json', '{"name":"cli-empty","private":true}\n']]),
      approvalId: arg(argv, 'approval-id'),
      attestation: read(arg(argv, 'attestation')),
      trust: read(arg(argv, 'trust')) as never,
      nodeId: arg(argv, 'node-id'),
      endpointId: arg(argv, 'endpoint-id'),
      refs: {
        d21: arg(argv, 'd21'),
        hg1002: arg(argv, 'hg-10-02'),
        adr: arg(argv, 'adr'),
        approval: arg(argv, 'approval'),
      },
      env,
    });
    console.log(
      `${r.label} | profile=${r.decision.profile} argv=${r.decision.argv.join(' ')} network=${r.decision.network} origin=${r.origin}`,
    );
    console.log(r.statement);
    console.log(
      `status=${r.outcome.status} exit=${r.outcome.exitCode} durationMs=${r.outcome.durationMs}`,
    );
    if (r.outcome.stdout) console.log(r.outcome.stdout.trimEnd());
    if (r.outcome.stderr) console.error(r.outcome.stderr.trimEnd());
    return r.outcome.status === 'completed' ? 0 : 1;
  } catch (e) {
    if (e instanceof RunRefused) {
      console.error(`REFUSED: ${e.reasons.join(', ')}`);
      return 2;
    }
    throw e;
  }
}
if (require.main === module) void main(process.argv.slice(2)).then((c) => process.exit(c));
