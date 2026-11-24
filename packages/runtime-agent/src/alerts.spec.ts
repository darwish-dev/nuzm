import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// the alert rules must only name metrics the code really emits, and every runbook anchor they cite must exist in the runbook
const root = join(__dirname, '../../..');
const alerts = readFileSync(join(root, 'infra/runtime/alerts/runtime-alerts.yaml'), 'utf8');
const sources = [
  ...readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => readFileSync(join(__dirname, f), 'utf8')),
  readFileSync(join(root, 'apps/api/src/modules/execution/runtime-metrics.ts'), 'utf8'),
].join('\n');
describe('alert rules stay in sync with the code', () => {
  const names = [...new Set([...alerts.matchAll(/\bnuzm_(?:agent|proxy|exec)_[a-z_]+/g)].map((m) => m[0]))];
  it('there are alert rules to check', () => expect(names.length).toBeGreaterThan(10));
  it.each(names)('metric %s is emitted by the code', (n) => expect(sources.includes(n), n).toBe(true));
  it('every runbook anchor exists as a heading', () => {
    const runbook = readFileSync(join(root, 'docs/security/sandbox/RUNBOOK-REAL-RUNNER.md'), 'utf8');
    const slug = (h: string) => h.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ +/g, '-');
    const heads = new Set([...runbook.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1]!)));
    for (const m of alerts.matchAll(/RUNBOOK-REAL-RUNNER\.md#([a-z0-9-]+)/g)) expect(heads.has(m[1]!), m[1]).toBe(true);
  });
  it('page alerts are the ones that can mean compromise or loss of control', () => {
    for (const a of ['NuzmRuntimeCleanupFailed', 'NuzmRuntimeKillSwitchEngaged', 'NuzmRuntimeStuckRun', 'NuzmEgressProxyRefusalsSpike', 'NuzmRuntimeNodeQuarantined'])
      expect(new RegExp(`alert: ${a}[\\s\\S]*?severity: page`).test(alerts), a).toBe(true);
  });
});
