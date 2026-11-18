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
 * console module, the audit read side, the billing module (finance reads, plan administration, platform-level
 * ledger postings) and the metering module (meter catalogue, provider cost capture and margin) the invoicing module (e-invoicing onboarding and the finance submissions console, S11b) the finrec module (cross-organization reconciliation runs and breaks, S12a) the compliance module (platform-level compliance registers such as the ROPA, M04 S13b) the enterprise module (M12: access reviews, audit assurance and policy versions, behind verified platform permissions) and the ops module (M12: incidents, alerts, recovery exercises, health) the cloud module (provider registry/accounts/catalog/health: admin-console register tables, M05) and the payments module (finance refunds resolve a payment's organization; pending-refund sweeper), all of which sit behind a verified platform permission or a service-level caller.
 */
describe('platform scope usage', () => {
  it('is only used from modules/admin, modules/audit, modules/billing, modules/metering, modules/payments, modules/invoicing, modules/finrec, modules/compliance, modules/cloud, modules/cloud-vendors, modules/data modules/email and modules/hosting and modules/domains and modules/enterprise and modules/ops', () => {
    const offenders = walk(src)
      .filter((f) => /withPlatformScope\(/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(src.length + 1))
      .filter(
        (f) =>
          !f.startsWith('modules/admin/') &&
          !f.startsWith('modules/audit/') &&
          !f.startsWith('modules/billing/') &&
          !f.startsWith('modules/metering/') &&
          !f.startsWith('modules/payments/') &&
          !f.startsWith('modules/invoicing/') &&
          !f.startsWith('modules/finrec/') &&
          !f.startsWith('modules/compliance/') &&
          !f.startsWith('modules/cloud/') &&
          !f.startsWith('modules/cloud-vendors/') &&
          !f.startsWith('modules/data/') &&
          !f.startsWith('modules/email/') &&
          !f.startsWith('modules/hosting/') &&
          !f.startsWith('modules/automation/') &&
          !f.startsWith('modules/marketplace/') &&
          !f.startsWith('modules/programs/') &&
          !f.startsWith('modules/domains/') &&
          !f.startsWith('modules/appbuilder/') && // M10A: sandbox reaper and CPU metering sweep across organizations
          // >>> M09: model provider registry, run oversight and sweepers (admin console register tables, service-level callers)
          !f.startsWith('modules/ai/') &&
          !f.startsWith('modules/builder/') &&
          !f.startsWith('modules/deploy/') &&
          !f.startsWith('modules/enterprise/') &&
          !f.startsWith('modules/ops/'),
        // <<< M09
      );
    expect(offenders).toEqual([]);
  });

  it('never sets app.platform_scope by hand outside the Db helper', () => {
    const offenders = walk(src).filter((f) => /app\.platform_scope/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.slice(src.length + 1))).toEqual([]);
  });
});
