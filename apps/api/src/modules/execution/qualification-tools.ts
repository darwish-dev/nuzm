import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath, sep } from 'node:path';

/**
 * P3-S02 qualification tooling (pure or filesystem-light; nothing here talks to a node or starts anything):
 *   - `fileSecretResolver`: the QUALIFICATION HOST's resolver for `vault://qualification/<name>` references: reads a file from a private directory OUTSIDE the repository. It is not a
 *     production vault (that is D-12); it exists so an engineer on a control-plane host can run the procedure without secrets in the repository, an environment variable or a command line.
 *   - `buildEvidenceIndex`: the append-only evidence index of a qualification run (`docs/security/sandbox/evidence/<node-id>/<date>/`): required files, sha256 of every file, and the
 *     cross-checks a reviewer would otherwise do by eye (the attestation points at the qualification report's digest, 0 escaped, 65/65 isolating, second run equal, no private key in the set).
 */
export class SecretFileRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'SecretFileRefused';
  }
}
const NAME = /^vault:\/\/qualification\/([A-Za-z0-9][A-Za-z0-9._-]{0,80})$/;
export function fileSecretResolver(
  dir: string,
  opts: { repoRoot: string; statFn?: typeof lstatSync; readFn?: (p: string) => string } = { repoRoot: process.cwd() },
): (ref: string) => Promise<string> {
  const abs = resolvePath(dir);
  const root = resolvePath(opts.repoRoot);
  if (abs === root || abs.startsWith(root + sep)) throw new SecretFileRefused('secrets_dir_inside_repository');
  const stat = opts.statFn ?? lstatSync;
  const read = opts.readFn ?? ((p: string) => readFileSync(p, 'utf8'));
  const d = stat(abs);
  if (!d.isDirectory() || d.isSymbolicLink()) throw new SecretFileRefused('secrets_dir_not_a_directory');
  if ((d.mode & 0o077) !== 0) throw new SecretFileRefused('secrets_dir_not_private');
  return async (ref) => {
    const m = NAME.exec(ref);
    if (!m) throw new SecretFileRefused('reference_not_in_qualification_namespace');
    const p = join(abs, m[1]!);
    const st = stat(p);
    if (st.isSymbolicLink() || !st.isFile()) throw new SecretFileRefused('secret_not_a_regular_file');
    if ((st.mode & 0o077) !== 0) throw new SecretFileRefused('secret_file_not_private');
    return read(p);
  };
}

export const REQUIRED_EVIDENCE = [
  'approval-references.txt',
  'bootstrap-plan.txt',
  'bootstrap-apply.log',
  'bootstrap-commit.txt',
  'inventory.txt',
  'declaration.json',
  'baseline.json',
  'qualification.json',
  'qualification.txt',
  'conformance.json',
  'integration-ticket-cases.txt',
  'attestation.signed.json',
  'negative-tests.txt',
  'hg-10-02-report.md',
  'second-run/inventory.txt',
  'second-run/qualification.json',
] as const;
export interface EvidenceEntry {
  name: string;
  sha256: string;
  bytes: number;
}
export interface EvidenceIndex {
  schema: 'nuzm.qualification-evidence-index/1';
  createdAt: string;
  entries: EvidenceEntry[];
  missing: string[];
  problems: string[];
  /** true only when nothing is missing and nothing is inconsistent; still NOT an approval: the named reviewer decides */
  complete: boolean;
}
const PRIVATE_KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/;
const json = <T>(b: Buffer | undefined): T | null => {
  try {
    return b ? (JSON.parse(b.toString('utf8')) as T) : null;
  } catch {
    return null;
  }
};
interface QualReport { mode?: string; label?: string; reportSha256?: string; totals?: { fail?: number; isolatingAttempts?: number; isolatingPass?: number; notVerified?: number } }
export function buildEvidenceIndex(files: ReadonlyMap<string, Buffer>, now: Date): EvidenceIndex {
  const problems: string[] = [];
  const missing = REQUIRED_EVIDENCE.filter((n) => !files.has(n));
  const entries: EvidenceEntry[] = [...files]
    .map(([name, b]) => ({ name, sha256: createHash('sha256').update(b).digest('hex'), bytes: b.length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const [name, b] of files) if (PRIVATE_KEY.test(b.toString('utf8'))) problems.push(`secret_in_evidence:${name}`);

  const q = json<QualReport>(files.get('qualification.json'));
  const q2 = json<QualReport>(files.get('second-run/qualification.json'));
  const att = json<{ node?: { nodeId?: string }; evidence?: { label?: string; escapeSuite?: { reportSha256?: string; escaped?: number; blocked?: number; isolatingAttempts?: number } } }>(files.get('attestation.signed.json'));
  const decl = json<{ node?: { nodeId?: string } }>(files.get('declaration.json'));
  const base = json<QualReport>(files.get('baseline.json'));
  const conf = json<{ fail?: number; target?: { label?: string }; skipped?: number }>(files.get('conformance.json'));
  const checkRun = (r: QualReport | null, name: string) => {
    if (!r) return;
    if (r.mode !== 'qualify') problems.push(`${name}:mode_not_qualify`);
    if (r.label === 'SIMULATED') problems.push(`${name}:label_simulated`);
    if ((r.totals?.fail ?? 1) !== 0) problems.push(`${name}:escaped_attempts`);
    if ((r.totals?.isolatingAttempts ?? 0) < 65 || r.totals?.isolatingPass !== r.totals?.isolatingAttempts) problems.push(`${name}:isolating_set_not_all_blocked`);
  };
  checkRun(q, 'qualification');
  checkRun(q2, 'second_run');
  if (q && q2 && JSON.stringify(q.totals) !== JSON.stringify(q2.totals)) problems.push('second_run:totals_differ');
  if (q && att && att.evidence?.escapeSuite?.reportSha256 !== q.reportSha256) problems.push('attestation:report_digest_does_not_match_qualification');
  if (att && att.evidence?.label !== 'LIVE-VERIFIED') problems.push('attestation:not_live_verified');
  if (att && decl && att.node?.nodeId !== decl.node?.nodeId) problems.push('attestation:node_differs_from_declaration');
  if (base && base.label !== 'SIMULATED') problems.push('baseline:not_labelled_simulated');
  if (conf && ((conf.fail ?? 1) !== 0 || (conf.skipped ?? 1) !== 0)) problems.push('conformance:not_clean');
  if (conf && conf.target?.label === 'SIMULATED') problems.push('conformance:ran_on_a_simulated_target');
  const neg = files.get('negative-tests.txt')?.toString('utf8');
  if (neg !== undefined && /\bFAIL\b/.test(neg)) problems.push('negative_tests:contains_fail');
  return { schema: 'nuzm.qualification-evidence-index/1', createdAt: now.toISOString(), entries, missing: [...missing], problems, complete: missing.length === 0 && problems.length === 0 };
}
