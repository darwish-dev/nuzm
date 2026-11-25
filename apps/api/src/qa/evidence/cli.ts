/**
 * P3-S08 evidence CLI (read-only; calls nothing, spends nothing).
 *   tsx src/qa/evidence/cli.ts verify           verify every file under docs/phase3/EVIDENCE/<track>/ ; exit 1 if any is rejected
 *   tsx src/qa/evidence/cli.ts verify <file>    verify one file (a path anywhere; placement rule is checked only for files inside EVIDENCE/<track>/)
 *   tsx src/qa/evidence/cli.ts matrix [--write] print the acceptance matrix (T1..T6 + cross-cutting gates); --write updates docs/phase3/EVIDENCE/ACCEPTANCE-MATRIX.md and .json
 *   tsx src/qa/evidence/cli.ts seal <file>      print the file with its contentHash set (tooling for evidence writers; writes nothing)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadApprovals } from './approvals';
import { buildMatrix, renderMatrixMarkdown } from './matrix';
import { evidenceDir, loadSchemas, repoRoot, seal, verifyAll, verifyRecord } from './verify';

const out = (s: string) => process.stdout.write(s + '\n');
function head(root: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

export function main(argv: string[]): number {
  const [cmd, arg] = argv;
  const root = repoRoot();
  if (cmd === 'verify' && arg === undefined) {
    const v = verifyAll(root);
    out(
      `evidence files: ${v.results.length}; accepted: ${v.accepted.length}; rejected: ${v.rejected.length}`,
    );
    for (const r of v.rejected) {
      out(`REJECTED ${r.file}`);
      for (const p of r.problems) out(`  [${p.rule}] ${p.where}: ${p.message}`);
    }
    return v.rejected.length === 0 ? 0 : 1;
  }
  if (cmd === 'verify' && arg) {
    const abs = resolve(arg);
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
    const inside =
      abs.startsWith(evidenceDir(root) + '/') && dirname(dirname(abs)) === evidenceDir(root);
    const v = verifyRecord(
      raw,
      {
        schemas: loadSchemas(root),
        dir: dirname(abs),
        placement: inside ? { trackDir: basename(dirname(abs)), fileName: basename(abs) } : null,
      },
      arg,
    );
    out(v.ok ? `ACCEPTED ${arg} (${v.record?.label}, ${v.record?.result})` : `REJECTED ${arg}`);
    for (const p of v.problems) out(`  [${p.rule}] ${p.where}: ${p.message}`);
    return v.ok ? 0 : 1;
  }
  if (cmd === 'matrix') {
    const v = verifyAll(root);
    const m = buildMatrix(v.accepted, loadApprovals(root), v.rejected);
    const md = renderMatrixMarkdown(m, {
      commit: head(root),
      generatedAt: new Date().toISOString(),
    });
    out(md);
    if (argv.includes('--write')) {
      writeFileSync(join(evidenceDir(root), 'ACCEPTANCE-MATRIX.md'), md);
      writeFileSync(
        join(evidenceDir(root), 'ACCEPTANCE-MATRIX.json'),
        JSON.stringify(
          {
            targets: m.targets,
            rows: m.cells.map((c) => ({
              id: c.req.id,
              status: c.status,
              live: c.live,
              simulated: c.simulated,
              blockers: c.blockers,
            })),
            rejected: m.rejected,
          },
          null,
          2,
        ) + '\n',
      );
    }
    return v.rejected.length === 0 ? 0 : 1;
  }
  if (cmd === 'seal' && arg) {
    out(
      JSON.stringify(
        seal(JSON.parse(readFileSync(resolve(arg), 'utf8')) as Record<string, unknown>),
        null,
        2,
      ),
    );
    return 0;
  }
  process.stderr.write('usage: cli.ts verify [file] | matrix [--write] | seal <file>\n');
  return 2;
}
if (require.main === module) process.exit(main(process.argv.slice(2)));
