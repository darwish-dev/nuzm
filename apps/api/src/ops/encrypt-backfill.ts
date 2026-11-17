import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TaxProfileSealer } from '../modules/invoicing';

/**
 * Operator job (M04 S13d): seal legacy plaintext tax profiles, or re-seal after a key rotation. Runs inside the application's own configuration
 * (same database role, vault and FIELD_ENCRYPTION_KEYS as the API), batch after batch until nothing is left to do:
 *   pnpm --filter @nuzm/api run encrypt:backfill
 * When it reports `remainingPlaintext: 0`, validate the constraint as the database owner:
 *   ALTER TABLE invoicing.tax_profiles VALIDATE CONSTRAINT tax_profiles_new_rows_sealed;
 */
async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const sealer = app.get(TaxProfileSealer);
    let total = { sealed: 0, resealed: 0 };
    for (;;) {
      const r = await sealer.run();
      total = { sealed: total.sealed + r.sealed, resealed: total.resealed + r.resealed };
      if (r.sealed + r.resealed === 0 || (r.remainingPlaintext === 0 && r.remainingOldKey === 0)) {
        console.log(
          JSON.stringify({
            ...total,
            remainingPlaintext: r.remainingPlaintext,
            remainingOldKey: r.remainingOldKey,
          }),
        );
        break;
      }
    }
  } finally {
    await app.close();
  }
}
void main();
