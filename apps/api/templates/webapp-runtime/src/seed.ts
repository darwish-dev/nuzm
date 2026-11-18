import { randomUUID } from 'node:crypto';
import { hashPassword, MIN_PASSWORD_LENGTH } from './auth.ts';
import { loadConfig } from './config.ts';
import { MemoryStore } from './memory-store.ts';
import { META } from './meta.ts';
import { createPool, PgStore } from './pg-store.ts';

/** Creates the first administrator: SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (at least 10 characters) from the environment. Idempotent. */
const cfg = loadConfig();
const email = process.env['SEED_ADMIN_EMAIL'];
const password = process.env['SEED_ADMIN_PASSWORD'];
if (!email || !password || password.length < MIN_PASSWORD_LENGTH) throw new Error('set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (at least ' + MIN_PASSWORD_LENGTH + ' characters)');
const admin = Object.values(META.roles).find((r) => r.admin);
if (!admin) throw new Error('the application has no administrator role');
const store = cfg.store === 'memory' ? new MemoryStore(META) : new PgStore(createPool(cfg.databaseUrl as string), META);
if (await store.findUserByEmail(email)) console.log('administrator already exists');
else {
  await store.insertUser({ id: randomUUID(), email: email.toLowerCase(), name: 'Administrator', role: admin.name, teamId: null, locale: META.defaultLocale === 'en' ? 'en' : 'ar', passwordHash: await hashPassword(password), active: true, createdAt: new Date().toISOString() });
  console.log('administrator created');
}
process.exit(0);
