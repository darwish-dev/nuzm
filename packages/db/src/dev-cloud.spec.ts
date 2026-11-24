import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LINES } from './dev-cloud';

/**
 * O-10 guard: the dev seed's simulator account must only use ids the mock-compute adapter lists, otherwise a customer creating a server from the seeded
 * dev catalog gets `region_not_listed`. @nuzm/db does not depend on the adapter package (module boundaries), so this reads the adapter's source text.
 */
const SRC = readFileSync(join(__dirname, '../../adapters/mock-compute/src/mock-compute.ts'), 'utf8');

function block(name: string): string {
  const m = new RegExp(`export const ${name}[^=]*= \\[([\\s\\S]*?)\\n\\];`).exec(SRC);
  if (!m) throw new Error(`${name} not found in the mock-compute source`);
  return m[1] ?? '';
}

describe('dev cloud seed: simulator line matches the mock-compute catalog (O-10)', () => {
  const mock = LINES.find((l) => l.key === 'mock');
  const listedRegions = [
    ...block('DEFAULT_MOCK_REGIONS').matchAll(/id: '([^']+)'[^}]*listed: true/g),
  ].map((m) => m[1]);
  const plans = [...block('DEFAULT_MOCK_PLANS').matchAll(/planRef: '([^']+)'/g)].map((m) => m[1]);
  const images = [...SRC.matchAll(/imageRef: '(mock-[a-z]+)'/g)].map((m) => m[1]);

  it('the adapter source parsed (the regexes did not silently match nothing)', () => {
    expect(mock).toBeDefined();
    expect(listedRegions.length).toBeGreaterThan(0);
    expect(plans.length).toBeGreaterThan(0);
    expect(images.length).toBeGreaterThan(0);
  });
  it('every seeded simulator region is a listed adapter region', () => {
    for (const [id] of mock?.regions ?? []) expect(listedRegions).toContain(id);
  });
  it('every seeded simulator size is an adapter plan', () => {
    for (const s of mock?.sizes ?? []) expect(plans).toContain(s.ref);
  });
  it('every seeded simulator image is an adapter image', () => {
    expect(mock?.images?.length).toBeGreaterThan(0);
    for (const [ref] of mock?.images ?? []) expect(images).toContain(ref);
  });
});
