import type { Db } from '@nuzm/platform';
import type { SandboxService } from './sandbox/sandbox.service';

/** Sandbox housekeeping, once a minute: reap idle / expired sandboxes and meter `ai.sandbox_cpu_seconds` of the running ones (idempotent per window). */
export class SandboxJobs {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private readonly db: Db,
    private readonly sandboxes: SandboxService,
  ) {}
  async tick(): Promise<{ reaped: number; metered: number }> {
    const reaped = await this.sandboxes.reapExpired();
    const rows = await this.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT id, org_id FROM builder.sandboxes WHERE state = 'ready' LIMIT 500`))
          .rows as { id: string; org_id: string }[],
    );
    let metered = 0;
    for (const r of rows)
      if (await this.sandboxes.meterCpu(r.org_id, r.id).catch(() => null)) metered++;
    return { reaped, metered };
  }
  start(everyMs = 60_000) {
    if (this.timer || process.env.APPBUILDER_KICK === 'off') return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), everyMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
