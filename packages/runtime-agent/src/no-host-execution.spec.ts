import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// R5 (structural): no code path of the agent or the node client can start a process on the machine it runs on, except through `NodeCommandRunner`, which refuses off the attested node.
const here = __dirname;
const production = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => ({ f: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }));
const roots = [
  here,
  join(here, '../../domain/src/ai/execution-gateway/node-protocol'),
  join(here, '../../../apps/api/src/modules/execution'),
  join(here, '../../../apps/api/src/modules/execution/internal'),
];
// importing a process-starting or code-evaluating facility is what matters (`RegExp#exec` and the CommandRunner's own `spawn` method are not): child_process, vm, worker_threads, cluster, eval, new Function
const PROCESS_API =
  /(?:from\s+|require\()\s*['"](?:node:)?(?:child_process|vm|worker_threads|cluster)['"]|\beval\(|new Function\(/;

describe('no host execution (R5)', () => {
  it('only command-runner.ts touches child_process, and only through the allow-listed, node-guarded runner', () => {
    const offenders: string[] = [];
    for (const r of roots)
      for (const { f, text } of production(r)) {
        const code = text
          .split('\n')
          .filter(
            (l) =>
              !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'),
          )
          .join('\n');
        if (PROCESS_API.test(code) && !f.endsWith('command-runner.ts')) offenders.push(f);
      }
    expect(offenders).toEqual([]);
  });
  it('the runner is refused by default and a real one needs the Linux node proof', () => {
    const t = readFileSync(join(here, 'command-runner.ts'), 'utf8');
    expect(t).toContain("if (proof.platform !== 'linux') throw new CommandRefused('not_linux')");
    expect(t).toContain('shell: false');
    expect(t).toContain('binary_not_allowed');
  });
  it('the production start-up path never selects a real runner without the proof (assembleAgent builds NodeCommandRunner only via create)', () => {
    const t = readFileSync(join(here, 'agent.ts'), 'utf8');
    expect(t).toContain('NodeCommandRunner.create(');
    expect(t).not.toMatch(/new NodeCommandRunner\(/);
  });
});
