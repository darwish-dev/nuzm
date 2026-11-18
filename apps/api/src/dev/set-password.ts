/**
 * DEV / OPERATOR bootstrap: set the email+password login of an existing user (used for platform staff, whose accounts are created by an
 * operator, never by self-registration). Refuses a non-local database. With no password argument a random one is generated and printed
 * once. The admin console still requires two-factor verification after the password.
 *   pnpm --filter @nuzm/api run set-password staff@example.test [password]
 * Database: DATABASE_ADMIN_URL (default the project-local cluster).
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { hashPassword, passwordProblem } from '../modules/identity';

export async function setPassword(
  client: Pick<Client, 'query'>,
  email: string,
  password: string,
  cost = { logN: 17, r: 8, p: 1 },
): Promise<{ userId: string; platform: boolean }> {
  const bad = passwordProblem(password, email);
  if (bad) throw new Error(`password refused by the policy: ${bad}`);
  const u = await client.query<{ id: string; is_platform_user: boolean }>(
    `SELECT id, is_platform_user FROM identity.users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (u.rowCount !== 1)
    throw new Error(`expected exactly one user with email ${email}, found ${u.rowCount}`);
  const hash = await hashPassword(password, cost);
  await client.query(
    `INSERT INTO identity.credentials (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, password_set_at = now(), failed_attempts = 0, last_failed_at = NULL, locked_until = NULL`,
    [u.rows[0]!.id, hash],
  );
  return { userId: u.rows[0]!.id, platform: u.rows[0]!.is_platform_user };
}

async function main() {
  const [email, given] = process.argv.slice(2);
  if (!email) throw new Error('usage: set-password <email> [password]');
  const url = process.env.DATABASE_ADMIN_URL ?? 'postgres://nuzm_admin@127.0.0.1:54329/nuzm_dev';
  if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname))
    throw new Error('set-password only runs against a local database');
  const password = given ?? randomBytes(15).toString('base64url');
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const r = await setPassword(c, email, password);
    console.log(`password set for ${email} (${r.platform ? 'platform staff' : 'customer'})`);
    if (!given) console.log(`generated password: ${password}`);
  } finally {
    await c.end();
  }
}

if (process.argv[1]?.endsWith('set-password.ts')) {
  main().catch((e) => {
    console.error(String((e as Error).message ?? e));
    process.exit(1);
  });
}
