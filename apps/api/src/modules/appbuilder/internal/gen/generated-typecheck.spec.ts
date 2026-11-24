import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CRM_SPEC } from '../fixtures/crm-appspec';
import { SAMPLE_SPEC } from '../fixtures/sample-spec';
import { generateProject } from './project';
import { platformFileHashes, runStaticGates } from './static-gates';
import { runtimeFiles } from './project';

/**
 * STATIC checks of generated projects: the TypeScript compiler type-checks every generated file (`tsc --noEmit`, nothing is executed) and the static gates pass. Together these are what the
 * loop would run first on a generated app. The dependencies come from this repository's own node_modules (symlinked); no install, no network.
 */
const apiDir = join(__dirname, '../../../../..');
const repoRoot = join(apiDir, '../..');
const tsc = [
  join(apiDir, 'node_modules/.bin/tsc'),
  join(apiDir, '../../node_modules/.bin/tsc'),
].find((p) => existsSync(p));
const cleanup: string[] = [];
afterAll(() => cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })));

const CASES = [
  ['sample, single tenant, no sign-up (Phase 2 defaults)', SAMPLE_SPEC, {}],
  ['crm, single tenant, sign-up', CRM_SPEC, { signupRole: 'auto' as const }],
  ['crm, multi-tenant', CRM_SPEC, { tenancy: 'multi' as const, signupRole: 'auto' as const }],
] as const;

describe.skipIf(!tsc)('generated full-stack projects type-check and pass the static gates', () => {
  for (const [name, spec, opts] of CASES)
    it(
      name,
      () => {
        const p = generateProject(spec, opts);
        const gates = runStaticGates(p.files, {
          platformFiles: platformFileHashes(runtimeFiles()),
        });
        expect(gates.findings.filter((f) => f.severity === 'blocker')).toEqual([]);
        const dir = mkdtempSync(join(tmpdir(), 'p3s05-tc-'));
        cleanup.push(dir);
        for (const [path, content] of p.files) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), content);
        }
        // a node_modules of symlinks to exactly the packages the generated package.json declares
        mkdirSync(join(dir, 'node_modules/@types'), { recursive: true });
        for (const [name, from] of [
          ['pg', join(apiDir, 'node_modules/pg')],
          ['@types/pg', join(apiDir, 'node_modules/@types/pg')],
          ['@types/node', join(repoRoot, 'node_modules/@types/node')],
        ] as const)
          symlinkSync(from, join(dir, 'node_modules', name));
        const r = spawnSync(tsc as string, ['--noEmit', '-p', 'tsconfig.json'], {
          cwd: dir,
          encoding: 'utf8',
          timeout: 170_000,
        });
        expect((r.stdout ?? '') + (r.stderr ?? ''), 'tsc output').toBe('');
        expect(r.status).toBe(0);
      },
      180_000,
    );
});
