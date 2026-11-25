/**
 * Control-plane metrics of the real runtime (Prometheus text exposition), from `RealRuntimeService.status()`. Node ids are labels (platform data); no tenant id, no run id. The agent
 * emits its own node-side metrics (`packages/runtime-agent/src/metrics.ts`); alert rules for both are in `infra/runtime/alerts/runtime-alerts.yaml`.
 */
export interface NodeStatusLike {
  nodeId: string;
  expiresAt: string;
  quarantined: string | null;
  dropped: string | null;
  inflight: number;
}
const esc = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
export function renderRuntimeMetrics(nodes: readonly NodeStatusLike[], nowMs: number): string {
  const out: string[] = [];
  for (const n of nodes) {
    const l = `{node="${esc(n.nodeId)}"}`;
    const left = Math.floor((Date.parse(n.expiresAt) - nowMs) / 1000);
    out.push(`nuzm_exec_node_quarantined${l} ${n.quarantined ? 1 : 0}`);
    out.push(`nuzm_exec_node_dropped${l} ${n.dropped ? 1 : 0}`);
    out.push(`nuzm_exec_node_inflight${l} ${n.inflight}`);
    out.push(`nuzm_exec_attestation_seconds_left${l} ${Number.isFinite(left) ? left : 0}`);
  }
  return `${out.join('\n')}\n`;
}
