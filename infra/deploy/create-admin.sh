#!/usr/bin/env bash
# Owner-run bootstrap. Prints a newly generated password only in the owner's terminal.
# Existing staff accounts and customer credentials are never modified.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo 'Run this from the root VPS terminal'; exit 1; }
export NUZM_NEW_ADMIN_EMAIL="${1:?staff email required}"
set -a
. /etc/nuzm/migrate.env
set +a
cd /srv/nuzm/current
node <<'JS'
const { Client } = require('./packages/platform/node_modules/pg');
const { randomBytes, randomUUID } = require('node:crypto');
const { hashPassword } = require('./apps/api/dist/modules/identity');
(async () => {
  const email = process.env.NUZM_NEW_ADMIN_EMAIL.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid email');
  const db = new Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await db.connect();
  try {
    await db.query('BEGIN');
    // Serialize this bootstrap, including simultaneous attempts for the same address.
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['nuzm-staff-bootstrap:' + email]);
    const existing = await db.query('SELECT id FROM identity.users WHERE lower(email)=$1 AND (is_platform_user OR issuer=$2)', [email, 'nuzm:staff']);
    if (existing.rowCount) throw new Error('A staff account already exists for this email. No account or password was changed.');
    const role = await db.query("SELECT 1 FROM tenancy.roles WHERE name='platform_admin' AND scope='platform'");
    if (role.rowCount !== 1) throw new Error('Platform admin role is missing; complete migrations first');
    const password = randomBytes(24).toString('base64url');
    const hash = await hashPassword(password, { logN: 17, r: 8, p: 1 });
    const id = randomUUID();
    await db.query("INSERT INTO identity.users (id,issuer,subject,email,display_name,locale,is_platform_user) VALUES ($1,'nuzm:staff',$2,$2,'Platform administrator','ar',true)", [id,email]);
    await db.query('INSERT INTO identity.credentials (user_id,password_hash) VALUES ($1,$2)', [id,hash]);
    await db.query("INSERT INTO tenancy.platform_roles (user_id,role) VALUES ($1,'platform_admin')", [id]);
    await db.query('COMMIT');
    console.log('Admin account created. Customer accounts were not changed.');
    console.log('URL: https://admin.nuzm.dev/ar/login');
    console.log('Email: ' + email);
    console.log('Password (save privately; do not paste in chat): ' + password);
    console.log('Complete two-factor enrollment after signing in.');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { await db.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
