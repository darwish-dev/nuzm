import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = __dirname;
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory()
      ? walk(p)
      : p.endsWith('.ts') && !p.endsWith('.spec.ts')
        ? [p]
        : [];
  });

/**
 * `Db.withPlatformScope` opens cross-tenant read access (RLS platform scope). It may only be used by the admin
 * console module, the audit read side and the billing module (finance reads, plan administration, platform-level
 * ledger postings), all of which sit behind a verified platform permission or a service-level caller.
 */
describe('platform scope usage', () => {
  it('is only used from modules/admin, modules/audit and modules/billing', () => {
    const offenders = walk(src)
      .filter((f) => /withPlatformScope\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1))
      .filter(
        (f) =>
          !f.startsWith('modules/admin/') &&
          !f.startsWith('modules/audit/') &&
          !f.startsWith('modules/billing/'),
      );
    expect(offenders).toEqual([]);
  });

  it('never sets app.platform_scope by hand outside the Db helper', () => {
    const offenders = walk(src).filter((f) => /app\.platform_scope/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(src.length + 1))).toEqual([]);
  });
});
