import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileDevSecretStore } from '../../../common/secrets';
import {
  parseTracks,
  reconcileEnvelopeInvoice,
  runExecutor,
  type ExecutorArgs,
} from './live-executor';

/**
 * Operator command of the Phase 3 live executor (`pnpm --filter @nuzm/api qualify:p3`, once the Master adds the script line). NOT run by CI.
 *
 *   --twin                          rehearsal against the MOCK TWIN: no key, no network, verdict SIMULATED
 *   (no flag)                       gates + dry run: prints the plan and the HARD USD CAP first, sends nothing
 *   --execute                       real run: every gate, then reads the sealed dev-vault key and calls the provider
 *   --tracks A,B,C                  default A,B,C; D = one controlled real error, E = synthetic agent tool loop, S = the nine-check suite (replaces B)
 *   --cap-usd 0.12                  a hard cap lower than (or equal to) the plan's worst case (default: the worst case)
 *   --vault-ref vault://dev/ai-claude --approval <file> --evidence <file>   (live modes; the files are the operator's, outside the repository)
 *   --out-dir <dir>                 where the evidence envelope is written (default: docs/phase3/EVIDENCE/provider)
 *   --reconcile-invoice <envelope.json> --invoice <invoice.json> [--tolerance-usd 0.005]   arithmetic only: no key, no request. invoice.json = {amountUsd, currency, source, vendorInputTokens?, vendorOutputTokens?}
 * Exit codes: 0 every claim passed (SIMULATED or LIVE-VERIFIED), 1 a claim failed or is NOT VERIFIED, 2 refused (nothing sent), 3 unexpected failure.
 */
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const json = (p: string | undefined): unknown => {
  if (!p) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
};

async function main(): Promise<void> {
  if (arg('reconcile-invoice')) {
    const r = reconcileEnvelopeInvoice(
      json(arg('reconcile-invoice')),
      json(arg('invoice')),
      arg('tolerance-usd') ?? '0',
    );
    if (r.kind === 'refused') {
      console.error('REFUSED. Problems:');
      for (const p of r.problems) console.error(`  - ${p}`);
      process.exit(2);
    }
    for (const c of r.claims) console.log(`${c.label.padEnd(13)} ${c.claim}: ${c.basis}`);
    process.exit(r.result.verdict === 'LIVE-VERIFIED' ? 0 : 1);
  }
  const tracks = parseTracks(arg('tracks'));
  if ('error' in tracks) {
    console.error(`REFUSED. Nothing was sent. ${tracks.error}`);
    process.exit(2);
  }
  const args: ExecutorArgs = {
    tracks,
    ...(arg('cap-usd') ? { capUsd: arg('cap-usd') as string } : {}),
    execute: process.argv.includes('--execute'),
    twin: process.argv.includes('--twin'),
    provider: arg('provider') ?? 'claude',
    vaultRef: arg('vault-ref'),
    approval: json(arg('approval')),
    evidence: json(arg('evidence')),
  };
  try {
    const r = await runExecutor(args, {
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
      // the cap comes first
      console.log(
        `HARD CAP of this run: ${r.plan.hardCapUsd} (${r.plan.worstCase.requests} requests, ${r.plan.worstCase.totalTokens} tokens at most)`,
      );
      console.log(JSON.stringify(r.plan, null, 2));
      process.exit(0);
    }
    const e = r.envelope;
    console.log(
      `hard cap ${e.cap.currency} nano ${e.cap.hardMaxNano}; spent ${e.cap.spentNano}${e.cap.overran ? '  OVERRAN' : ''}`,
    );
    for (const c of e.claims) console.log(`${c.label.padEnd(13)} ${c.claim}`);
    console.log(
      `run ${e.id}: ${e.verdict}${e.mode === 'mock' ? ' (mock twin: nothing real was verified)' : ''}`,
    );
    const dir = arg('out-dir') ?? join('docs', 'phase3', 'EVIDENCE', 'provider');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, r.fileName), JSON.stringify(e, null, 2), { mode: 0o600 });
    console.log(`evidence envelope: ${join(dir, r.fileName)}`);
    process.exit(e.verdict === 'SIMULATED' || e.verdict === 'LIVE-VERIFIED' ? 0 : 1);
  } catch {
    console.error(
      'the executor failed unexpectedly (no detail is printed: it could carry request data)',
    );
    process.exit(3);
  }
}
void main();
