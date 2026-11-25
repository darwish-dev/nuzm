import { readFileSync } from 'node:fs';
import { previewRateCard, type RateCardPreviewInput } from './rate-card-preview';

/**
 *   pnpm --filter @nuzm/api exec tsx src/modules/ai/internal/rate-card-preview-cli.ts <input.json>
 * Prints the rate card JSON for the admin console and the basis; saves nothing, calls nothing. Exit 0 ok, 2 refused.
 */
async function main(): Promise<number> {
  const path = process.argv[2];
  let input: RateCardPreviewInput;
  try {
    input = JSON.parse(readFileSync(path ?? '', 'utf8')) as RateCardPreviewInput;
  } catch {
    console.error(
      'usage: rate-card-preview-cli.ts <input.json> (see rate-card-preview.ts for the fields)',
    );
    return 2;
  }
  const r = await previewRateCard(input);
  if (!r.ok) {
    console.error('REFUSED:');
    for (const p of r.problems) console.error(`  - ${p}`);
    return 2;
  }
  console.log(
    JSON.stringify({ rateCard: r.rateCard, basis: r.basis, warnings: r.warnings }, null, 2),
  );
  return 0;
}
main().then((c) => process.exit(c));
