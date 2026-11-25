/**
 * Entry point of Track H (see `qualify-core.ts`). Run from the repository root:
 *   pnpm exec tsx packages/domain/src/ai/benchmarks/cli/qualify.ts --stage A                 (simulated, the default)
 *   pnpm exec tsx packages/domain/src/ai/benchmarks/cli/qualify.ts --mode live --stage A     (refuses unless every approval exists)
 * It reads only `process.argv` and `process.env`, writes only to stdout/stderr (and to `--out` when given), and calls no provider by itself.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CaptureSource } from '../live-runner';
import { runCli } from './qualify-core';

const loadSource = async (modulePath: string): Promise<CaptureSource> => {
  const mod = (await import(pathToFileURL(resolve(modulePath)).href)) as {
    createCaptureSource?: () => CaptureSource | Promise<CaptureSource>;
  };
  if (typeof mod.createCaptureSource !== 'function')
    throw new Error('the capture source module must export createCaptureSource()');
  return mod.createCaptureSource();
};

runCli(
  process.argv.slice(2),
  process.env,
  { out: (s) => console.log(s), err: (s) => console.error(s) },
  { now: () => new Date().toISOString(), loadSource, writeFile: (p, c) => writeFileSync(p, c) },
).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : 'unexpected error');
    process.exitCode = 1;
  },
);
