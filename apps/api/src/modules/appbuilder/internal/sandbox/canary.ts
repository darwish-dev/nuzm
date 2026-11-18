import { randomBytes } from 'node:crypto';
import { redactSecrets } from './paths';

/**
 * Canary secrets (M10 §9): unique tokens planted where generated code must never reach: the runner host environment, the control-plane network, neighbour sandboxes and
 * well-known credential paths. A token appearing in ANY output, log, artifact, egress request or export is a security event and fails the escape suite.
 * Tokens carry no meaning and open nothing: they are random values whose only property is that they are unique and recognisable.
 */
export type CanaryLocation =
  | 'runner_host_env'
  | 'control_plane_net'
  | 'neighbour_sandbox'
  | 'well_known_path'
  | 'metadata_stub';
export interface Canary {
  id: string;
  location: CanaryLocation;
  value: string;
  /** Where it was planted (a variable name, a path, a host): documented, never a real resource. */
  where: string;
}
export abstract class SecurityAlertPort {
  abstract alert(a: {
    kind: 'canary_triggered' | 'sandbox_escape_suspected';
    sandboxId: string | null;
    canaryId?: string;
    where: string;
  }): Promise<void>;
}
export class MemorySecurityAlerts extends SecurityAlertPort {
  readonly alerts: { kind: string; sandboxId: string | null; canaryId?: string; where: string }[] =
    [];
  async alert(a: {
    kind: 'canary_triggered' | 'sandbox_escape_suspected';
    sandboxId: string | null;
    canaryId?: string;
    where: string;
  }) {
    this.alerts.push(a);
  }
}

export class CanaryRegistry {
  private readonly all = new Map<string, Canary>();
  constructor(private readonly alerts: SecurityAlertPort) {}
  plant(location: CanaryLocation, where: string): Canary {
    const id = randomBytes(6).toString('hex');
    const c: Canary = { id, location, where, value: `NZCANARY-${randomBytes(12).toString('hex')}` };
    this.all.set(id, c);
    return c;
  }
  /** The standard set planted for a runner host (one of each location). */
  plantStandardSet(): Canary[] {
    return [
      this.plant('runner_host_env', 'env:NUZM_RUNNER_CANARY'),
      this.plant('control_plane_net', 'host:cp-canary.nuzm.internal'),
      this.plant('neighbour_sandbox', 'file:/work/.neighbour-canary'),
      this.plant('well_known_path', 'file:~/.aws/credentials'),
      this.plant('metadata_stub', 'http://metadata-stub.internal/latest/meta-data/iam'),
    ];
  }
  list(): Canary[] {
    return [...this.all.values()];
  }
  /** Scan any text (stdout, logs, a file, an egress URL or body) for a planted token; each hit raises an alert. Returns the canaries found. */
  async scan(text: string, ctx: { sandboxId: string | null; source: string }): Promise<Canary[]> {
    const hits = this.list().filter((c) => text.includes(c.value));
    for (const c of hits)
      await this.alerts.alert({
        kind: 'canary_triggered',
        sandboxId: ctx.sandboxId,
        canaryId: c.id,
        where: `${ctx.source} (${c.location})`,
      });
    return hits;
  }
  /** Log-safe: removes canary values (and any other secret pattern) from text that will be stored. */
  redact(text: string): string {
    let t = text;
    for (const c of this.all.values()) t = t.split(c.value).join('[redacted:canary]');
    return redactSecrets(t);
  }
}
