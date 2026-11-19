/**
 * DEV ONLY: credit the AI wallet of the organizations in the LOCAL database, so builder runs are not stopped by a 0 balance. It uses the real ledger posting
 * service (the only writer of ledger rows): a balanced `credit_grant` posting with its audit event, idempotent per organization and batch. Refuses a
 * non-local database and production.
 *   pnpm --filter @nuzm/api run grant-ai-credits [amountMinor] [organization id, name or slug] [--again]
 * `amountMinor` is SAR minor units (default 500000 = SAR 5,000.00). Without an organization every organization is credited. `--again` adds a new grant
 * instead of repeating the first one (which is a no-op).
 */
import 'reflect-metadata';
import { Client } from 'pg';
import { Db } from '@nuzm/platform';
import { DbAuditSink } from '../modules/audit';
import { LedgerPostingService, recipes } from '../modules/billing';

const LOCAL = ['127.0.0.1', 'localhost', '::1'];

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('refused: production');
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const again = process.argv.includes('--again');
  const amount = args[0] ?? '500000';
  if (!/^[1-9]\d{0,11}$/.test(amount)) throw new Error('amountMinor must be a positive integer');
  const filter = args[1];
  const adminUrl =
    process.env.DATABASE_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev';
  const appUrl =
    process.env.DATABASE_URL ?? 'postgres://nuzm_app:nuzm_dev_only@127.0.0.1:54329/nuzm_dev';
  for (const u of [adminUrl, appUrl])
    if (!LOCAL.includes(new URL(u).hostname))
      throw new Error('grant-ai-credits only runs against a local database');

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  let orgs: { id: string; name: string }[];
  try {
    const r = await admin.query<{ id: string; name: string }>(
      filter
        ? `SELECT id, name FROM tenancy.organizations WHERE id::text = $1 OR lower(name) = lower($1) OR lower(slug) = lower($1)`
        : `SELECT id, name FROM tenancy.organizations ORDER BY created_at`,
      filter ? [filter] : [],
    );
    orgs = r.rows;
  } finally {
    await admin.end();
  }
  if (orgs.length === 0) throw new Error('no organization found: register and create one first');

  const db = new Db(appUrl);
  const key = process.env.AUDIT_HASH_KEY
    ? new Uint8Array(Buffer.from(process.env.AUDIT_HASH_KEY, 'base64'))
    : new Uint8Array(Buffer.from('nuzm-dev-only-audit-hash-key-not-secret'));
  const ledger = new LedgerPostingService(db, new DbAuditSink(db, key));
  const batch = again ? Date.now().toString(36) : 'v1';
  for (const o of orgs) {
    const grantId = `dev-ai-credits-${o.id}-${amount}-${batch}`;
    const res = await ledger.post(
      recipes.creditGrant({
        orgId: o.id,
        amountMinor: amount,
        currency: 'SAR',
        reason: 'dev test credits (local database only)',
        grantId,
      }),
      grantId,
    );
    console.log(
      `${o.name}: ${res.duplicate ? 'already granted (use --again for another)' : `+${amount} minor SAR`}`,
    );
  }
  await db.close();
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  },
);
