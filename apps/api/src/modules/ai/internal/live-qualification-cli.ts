import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileDevSecretStore } from '../../../common/secrets';
import { runQualificationCommand, type QualifyArgs } from './live-qualification';
import type { QualificationTrack } from '@nuzm/adapter-model';

/**
 * Shared command line of the three qualification scripts (`qualify-a-connection.ts`, `qualify-b-tool-calling.ts`, `qualify-c-code-generation.ts`). NOT run by CI.
 *
 *   --twin                          run against the MOCK TWIN: no key, no network, verdict SIMULATED
 *   (no flag)                       gates + dry run: prints the plan and the worst-case cost, sends nothing
 *   --execute                       real run: every gate, then reads the sealed dev-vault key and calls the provider
 *   --vault-ref vault://dev/ai-claude --approval <file> --evidence <file>   (live modes only; files are the operator's, outside the repository)
 *   --out-dir <dir>                 where the evidence record is written (default: print only); the file name is printed
 * Exit codes: 0 PASS (SIMULATED or LIVE-VERIFIED), 1 FAIL or NOT VERIFIED, 2 refused (nothing sent), 3 unexpected failure.
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

export async function runQualificationCli(track: QualificationTrack): Promise<void> {
  const args: QualifyArgs = {
    track,
    twin: process.argv.includes('--twin'),
    execute: process.argv.includes('--execute'),
    provider: arg('provider') ?? 'claude',
    vaultRef: arg('vault-ref'),
    approval: json(arg('approval')),
    evidence: json(arg('evidence')),
  };
  try {
    const r = await runQualificationCommand(args, {
      env: process.env,
      readKey: async (ref) => {
        const seal = Buffer.from(process.env.SESSION_SEAL_KEY ?? '', 'base64');
        if (seal.length !== 32)
          throw new Error('SESSION_SEAL_KEY must be 32 bytes, base64-encoded');
        return new FileDevSecretStore(new Uint8Array(seal)).get(ref);
      },
    });
    if (r.kind === 'refused') {
      console.error('REFUSED. Nothing was sent. Problems:');
      for (const p of r.problems) console.error(`  - ${p}`);
      process.exit(2);
    }
    if (r.kind === 'dry_run') {
      console.log(JSON.stringify(r.plan, null, 2));
      process.exit(0);
    }
    const e = r.evidence;
    for (const c of e.checks)
      console.log(`${c.ok && c.ran ? 'PASS' : c.ran ? 'FAIL' : 'NOT RUN'}  ${c.id}  ${c.detail}`);
    console.log(
      `track ${e.track} (${e.trackName}) on ${e.provider}/${e.model}: ${e.verdict}${e.verdict === 'SIMULATED' ? ' (mock twin: nothing real was verified)' : ''}; requests ${e.totals.requests}, tokens ${e.totals.tokensIn}+${e.totals.tokensOut}, cost(nano ${e.currency}) ${e.totals.costNano}`,
    );
    const dir = arg('out-dir');
    if (dir) {
      writeFileSync(join(dir, r.fileName), JSON.stringify(e, null, 2), { mode: 0o600 });
      console.log(`evidence record: ${r.fileName}`);
    }
    process.exit(e.verdict === 'SIMULATED' || e.verdict === 'LIVE-VERIFIED' ? 0 : 1);
  } catch {
    console.error(
      'the qualification failed unexpectedly (no detail is printed: it could carry request data)',
    );
    process.exit(3);
  }
}
