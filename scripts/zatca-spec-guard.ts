/**
 * ZATCA spec guard (docs/11 §5 "Spec pinning"): fails when the e-invoice GENERATOR changes without a version bump note, or when the pinned official
 * documents change without a re-pin. `--update "<note>"` records the new generator hash in spec/zatca/VERSION and appends the note to the changelog.
 * Run by `pnpm verify`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..');
const DIR = 'apps/api/src/modules/invoicing/internal/zatca';
const GENERATOR_FILES = [
  `${DIR}/profile.ts`,
  `${DIR}/build-document.ts`,
  `${DIR}/ubl.ts`,
  `${DIR}/hash-chain.ts`,
  `${DIR}/qr-tlv.ts`,
  `${DIR}/signing.ts`,
  `${DIR}/csr.ts`,
  `${DIR}/validator.ts`,
  'spec/zatca/synthetic-profile.yaml',
];

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    })
    .filter((p) => !p.endsWith('.gitkeep'))
    .sort();
}
export const generatorHash = () =>
  sha(GENERATOR_FILES.map((f) => `${f}\n${sha(readFileSync(join(root, f)))}`).join('\n'));
export const officialHash = () =>
  sha(
    walk(join(root, 'spec/zatca/official'))
      .map((p) => `${relative(root, p)}\n${sha(readFileSync(p))}`)
      .join('\n'),
  );

function main(): number {
  const versionPath = join(root, 'spec/zatca/VERSION');
  const v = JSON.parse(readFileSync(versionPath, 'utf8')) as {
    specVersion: string;
    official: { sha256: string };
    generator: { files: string[]; sha256: string };
  };
  const gen = generatorHash();
  const off = officialHash();
  const changelogPath = join(root, 'spec/zatca/CHANGELOG.md');
  const i = process.argv.indexOf('--update');
  if (i >= 0) {
    const note = process.argv[i + 1];
    if (!note || note.length < 10) {
      console.error('zatca guard: --update needs a note of at least 10 characters');
      return 2;
    }
    v.generator = { files: GENERATOR_FILES, sha256: gen };
    v.official.sha256 = off;
    writeFileSync(versionPath, JSON.stringify(v, null, 2) + '\n');
    writeFileSync(
      changelogPath,
      readFileSync(changelogPath, 'utf8') +
        `- ${new Date().toISOString().slice(0, 10)} \`${gen.slice(0, 16)}\` ${note}\n`,
    );
    console.log(`zatca guard: recorded generator ${gen.slice(0, 16)}`);
    return 0;
  }
  const problems: string[] = [];
  if (v.generator.sha256 !== gen)
    problems.push(
      `the generator sources changed (now ${gen.slice(0, 16)}, pinned ${v.generator.sha256.slice(0, 16) || 'none'}): run pnpm zatca:guard --update "<note>"`,
    );
  if (v.official.sha256 !== off)
    problems.push(
      'spec/zatca/official changed: re-pin with pnpm zatca:guard --update "<note>" and set specVersion',
    );
  if (!readFileSync(changelogPath, 'utf8').includes(`\`${v.generator.sha256.slice(0, 16)}\``))
    problems.push('CHANGELOG.md has no entry for the pinned generator hash');
  if (problems.length) {
    for (const p of problems) console.error(`zatca guard: ${p}`);
    return 1;
  }
  console.log(
    `zatca guard OK: spec ${v.specVersion}, generator ${gen.slice(0, 16)}, ${walk(join(root, 'spec/zatca/official')).length} official file(s)`,
  );
  return 0;
}
if (require.main === module) process.exit(main());
