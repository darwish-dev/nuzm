import { describe, expect, it } from 'vitest';
import { renderRuntimeMetrics } from './runtime-metrics';

describe('runtime metrics (control plane)', () => {
  it('renders per-node quarantine, drop, inflight and attestation time left; no tenant data, bounded label', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    const t = renderRuntimeMetrics([
      { nodeId: 'node-1', expiresAt: '2026-12-10T00:00:00Z', quarantined: null, dropped: null, inflight: 2 },
      { nodeId: 'weird"node\n{x}', expiresAt: 'not a date', quarantined: 'cleanup_failed', dropped: 'attestation_expired', inflight: 0 },
    ], now);
    expect(t).toContain('nuzm_exec_attestation_seconds_left{node="node-1"} 777600');
    expect(t).toContain('nuzm_exec_node_inflight{node="node-1"} 2');
    expect(t).toContain('nuzm_exec_node_quarantined{node="weird_node__x_"} 1');
    expect(t).toContain('nuzm_exec_node_dropped{node="weird_node__x_"} 1');
    expect(t.split('\n').every((l) => l === '' || /^nuzm_exec_[a-z_]+\{node="[A-Za-z0-9._-]+"\} -?\d+$/.test(l))).toBe(true);
  });
});
