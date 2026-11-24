import { Module } from '@nestjs/common';
import { AuditSink } from '../../common/audit';
import { DB } from '../../common/tokens';
import { AccessModule } from '../access';
import { IdentityModule } from '../identity';
import { AdminBenchmarksController } from './admin-benchmarks.controller';
import { BenchmarkFlags, BenchmarksService } from './internal/benchmarks.service';
import { BenchmarkStore, PgBenchmarkStore } from './internal/store';
import type { Db } from '@nuzm/platform';

/** Platform feature flag `ai.benchmarks` (platform.feature_flags, global row), default OFF. */
class PgBenchmarkFlags extends BenchmarkFlags {
  constructor(private readonly db: Db) {
    super();
  }
  async enabled(): Promise<boolean> {
    const rows = await this.db.withPlatformScope(async (c) => (await c.query(`SELECT value FROM platform.feature_flags WHERE key = 'ai.benchmarks' AND org_id IS NULL`)).rows);
    return rows.some((r) => r.value === true || (typeof r.value === 'object' && r.value !== null && (r.value as { enabled?: unknown }).enabled === true));
  }
}

/** Benchmark and evaluation engine (S-AG5) admin API. Registration in `app.module.ts` is done by the Master (see REPORT-03). */
@Module({
  imports: [IdentityModule, AccessModule],
  controllers: [AdminBenchmarksController],
  providers: [
    { provide: BenchmarkStore, inject: [DB], useFactory: (db: Db) => new PgBenchmarkStore(db) },
    { provide: BenchmarkFlags, inject: [DB], useFactory: (db: Db) => new PgBenchmarkFlags(db) },
    { provide: BenchmarksService, inject: [BenchmarkStore, AuditSink, BenchmarkFlags], useFactory: (s: BenchmarkStore, a: AuditSink, f: BenchmarkFlags) => new BenchmarksService(s, a, f) },
  ],
})
export class BenchmarksModule {}
