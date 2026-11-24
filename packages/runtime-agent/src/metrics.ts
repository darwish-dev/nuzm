/**
 * Prometheus text-exposition metrics of the agent. Counters and gauges only, no labels that carry tenant data (org ids are NOT labels). Served on a loopback-only listener
 * (`server.ts`); the node's metrics shipper scrapes it. Alert rules over these names are in `infra/runtime/alerts/runtime-alerts.yaml`.
 */
export class Metrics {
  private readonly c = new Map<string, number>();
  private readonly g = new Map<string, () => number>();
  inc(name: string, by = 1, label?: string): void {
    const k = label ? `${name}{reason="${label.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 40)}"}` : name;
    this.c.set(k, (this.c.get(k) ?? 0) + by);
  }
  gauge(name: string, f: () => number): void {
    this.g.set(name, f);
  }
  get(name: string, label?: string): number {
    const k = label ? `${name}{reason="${label}"}` : name;
    return this.c.get(k) ?? 0;
  }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.c].sort()) lines.push(`${k} ${v}`);
    for (const [k, f] of [...this.g].sort()) {
      const v = ((): number => {
        try {
          return f();
        } catch {
          return Number.NaN;
        }
      })();
      lines.push(`${k} ${v}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
