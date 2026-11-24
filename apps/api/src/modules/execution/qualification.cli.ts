import { createPrivateKey } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { executionGateway as eg } from '@nuzm/domain';
import { buildEvidenceIndex, fileSecretResolver } from './qualification-tools';

/**
 * Qualification procedure CLI (P3-S02). Subcommands map to the steps of docs/parallel/RUNTIME-QUALIFICATION.md §0.2:
 *   conformance  S10  the fixtures with the REAL files through the harness over https/mTLS      (refuses without an approval ref confirmed in NUZM_QUALIFICATION_APPROVED)
 *   sign         S13  the REVIEWER completes and signs a draft attestation with their OWN key (read from a file outside the repository)
 *   negative     S14  the attestation negative tests against the signed attestation and the node
 *   evidence     S15  the append-only evidence index of a directory (required files, sha256, cross-checks)
 * (S8, the escape suite, is `escape-runner.cli.ts --mode qualify`.) Nothing here runs without a real, approved staging node; the tests run these paths against a simulated agent only.
 *   npx tsx apps/api/src/modules/execution/qualification.cli.ts <subcommand> ...
 * Exit codes: 0 ok; 1 a case failed / evidence incomplete; 2 refused or bad usage.
 */
const arg = (argv: string[], n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const readJson = <T>(f: string | undefined): T => {
  if (!f) throw new Error('missing file argument');
  return JSON.parse(readFileSync(f, 'utf8')) as T;
};
const keyFileOk = (f: string): string | null => {
  const abs = resolve(f);
  const repo = resolve(process.cwd());
  if (abs === repo || abs.startsWith(repo + sep)) return 'key_file_inside_repository';
  const st = lstatSync(abs);
  if (st.isSymbolicLink() || !st.isFile()) return 'key_file_not_a_regular_file';
  if ((st.mode & 0o077) !== 0) return 'key_file_not_private';
  return null;
};

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'conformance') {
      const secretsDir = arg(rest, 'secrets-dir');
      if (!secretsDir) throw new Error('--secrets-dir is required');
      const target = await eg.createQualificationTarget({
        connection: readJson<eg.NodeEndpointConfig>(arg(rest, 'connection')),
        declaration: readJson<eg.NodeDeclaration>(arg(rest, 'declaration')),
        approvalRef: arg(rest, 'approval'),
        env,
        resolve: fileSecretResolver(secretsDir, { repoRoot: process.cwd() }),
      });
      const report = await eg.runPortConformance(target);
      console.log(
        `conformance ${report.conformanceVersion} | ${report.target.name} | label=${report.target.label}`,
      );
      console.log(
        `cases=${report.total} PASS=${report.pass} FAIL=${report.fail} SKIPPED=${report.skipped} reportSha256=${report.reportSha256}`,
      );
      console.log(report.statement);
      const out = arg(rest, 'out');
      if (out) writeFileSync(out, JSON.stringify(report, null, 2), { flag: 'wx' });
      return report.fail > 0 ? 1 : 0;
    }
    if (cmd === 'sign') {
      const keyFile = arg(rest, 'key');
      if (!keyFile)
        throw new Error(
          "--key is required (the reviewer's private key file, outside the repository)",
        );
      const bad = keyFileOk(keyFile);
      if (bad) {
        console.error(`REFUSED: ${bad}`);
        return 2;
      }
      const draft = readJson<eg.DraftAttestation>(arg(rest, 'draft'));
      const now = new Date();
      const { attestation, verdict } = eg.completeAndSignAttestation(
        draft,
        {
          keyId: arg(rest, 'key-id') ?? '',
          securityReview: {
            ref: arg(rest, 'review-ref') ?? '',
            reviewer: arg(rest, 'reviewer') ?? '',
            decidedAt: arg(rest, 'decided-at') ?? now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          },
          d21: arg(rest, 'd21') ?? '',
        },
        createPrivateKey(readFileSync(keyFile, 'utf8')),
        { environments: ['staging'], now },
      );
      const out = arg(rest, 'out');
      if (out) writeFileSync(out, JSON.stringify(attestation, null, 2), { flag: 'wx' });
      console.log(
        verdict.ok
          ? 'signed; verifies in LIVE mode against the reviewer key'
          : `signed, but the verifier REFUSES it: ${verdict.reasons.join(', ')}`,
      );
      return verdict.ok ? 0 : 1;
    }
    if (cmd === 'negative') {
      const secretsDir = arg(rest, 'secrets-dir');
      if (!secretsDir) throw new Error('--secrets-dir is required');
      const conn = readJson<eg.NodeEndpointConfig>(arg(rest, 'connection'));
      const decl = readJson<eg.NodeDeclaration>(arg(rest, 'declaration'));
      const att = readJson<unknown>(arg(rest, 'attestation'));
      const trusted = readJson<eg.TrustedKeys>(arg(rest, 'trusted-keys'));
      const { node } = await eg.connectForQualification({
        connection: conn,
        declaration: decl,
        approvalRef: arg(rest, 'approval'),
        env,
        resolve: fileSecretResolver(secretsDir, { repoRoot: process.cwd() }),
      });
      // the node is presented as verified here only to exercise the SERVICE's refusals; no run is started
      const verified = Object.assign(Object.create(node), { isolation: 'verified' as const });
      const kit = eg.createSimulatedKit();
      const res = await eg.runAttestationNegativeTests({
        attestation: att,
        trusted,
        environments: ['staging'],
        node: { nodeId: conn.nodeId, endpointId: conn.endpointId, runtime: verified },
        now: () => Date.now(),
        simulatedAttestation: kit.attestation({ nodeId: conn.nodeId, endpointId: conn.endpointId }),
      });
      for (const r of res)
        console.log(`${r.status} ${r.id} ${r.title} (expected ${r.expected}; got ${r.note})`);
      return res.some((r) => r.status === 'FAIL') ? 1 : 0;
    }
    if (cmd === 'evidence') {
      const dir = arg(rest, 'dir');
      if (!dir) throw new Error('--dir is required');
      const files = new Map<string, Buffer>();
      const walk = (rel: string) => {
        for (const n of readdirSync(join(dir, rel))) {
          if (n === 'INDEX.json') continue;
          const r = rel ? `${rel}/${n}` : n;
          const st = lstatSync(join(dir, r));
          if (st.isSymbolicLink()) throw new Error(`symlink in evidence: ${r}`);
          if (st.isDirectory()) walk(r);
          else files.set(r, readFileSync(join(dir, r)));
        }
      };
      walk('');
      const idx = buildEvidenceIndex(files, new Date());
      const target = join(dir, 'INDEX.json');
      if (existsSync(target)) {
        console.error(
          'REFUSED: INDEX.json already exists (evidence is append-only: create a new dated directory)',
        );
        return 2;
      }
      writeFileSync(target, JSON.stringify(idx, null, 2), { flag: 'wx' });
      console.log(
        `files=${idx.entries.length} missing=${idx.missing.length} problems=${idx.problems.length} complete=${idx.complete}`,
      );
      for (const m of idx.missing) console.log(`MISSING ${m}`);
      for (const p of idx.problems) console.log(`PROBLEM ${p}`);
      return idx.complete ? 0 : 1;
    }
    console.error('usage: qualification.cli.ts <conformance|sign|negative|evidence> ...');
    return 2;
  } catch (e) {
    if (e instanceof eg.LiveRunRefused || e instanceof eg.SignRefused) {
      console.error(`REFUSED: ${e.reasons.join(', ')}`);
      return 2;
    }
    console.error(`ERROR: ${(e as Error).message}`);
    return 2;
  }
}
if (require.main === module) void main(process.argv.slice(2)).then((c) => process.exit(c));
