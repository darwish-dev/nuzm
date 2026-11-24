import { builderTools } from '@nuzm/domain';
import { describe, expect, it } from 'vitest';
import { ProductGeneratorRegistry } from './generator-registry';
import { LifecycleRunner } from './lifecycle.runner';
import { MemoryEnv, MemoryHost } from './lifecycle.testing';
import type { FileGenerator } from './lifecycle.types';

const T = builderTools;
const gen = (label: string, calls: string[]): FileGenerator => ({
  kind: 'model',
  async generate(i) {
    calls.push(`${label}:${i.task.id}`);
    return {
      ops: i.task.files.map((path) => ({
        op: 'add' as const,
        path,
        content: `// ${label}\nexport {};\n`,
      })),
    };
  },
});

describe('the product generator registry (how the website, full-stack and mobile tracks plug into the loop)', () => {
  it('registers once per product type, refuses unknown types and double registration, and shows the live map', () => {
    const r = new ProductGeneratorRegistry();
    r.register('s04-website', ['website', 'landing'], gen('web', []));
    expect(r.ownerOf('website')).toBe('s04-website');
    expect(r.asMap().has('landing')).toBe(true);
    expect(() => r.register('s05', ['website'], gen('x', []))).toThrow(
      /already has a generator \(registered by s04-website\)/,
    );
    expect(() => r.register('s05', ['nonsense'], gen('x', []))).toThrow(/unknown product type/);
    expect(() => r.register('s05', [], gen('x', []))).toThrow();
    // a failed registration registers nothing: the other types in the same call stay free
    expect(() => r.register('s05', ['fullstack', 'website'], gen('x', []))).toThrow();
    expect(r.ownerOf('fullstack')).toBeNull();
    const live = r.asMap();
    r.register('s06', ['mobile'], gen('m', []));
    expect(live.has('mobile')).toBe(true);
  });

  it('the loop uses the registered generator for its product type and the default for every other; the later tasks see the contract of earlier files', async () => {
    const calls: string[] = [];
    const reg = new ProductGeneratorRegistry();
    reg.register('s04-website', ['website'], gen('web', calls));
    const run = async (prompt: string) => {
      const host = new MemoryHost();
      host.input = { prompt };
      const env = new MemoryEnv();
      env.generators = reg.asMap();
      const out = await new LifecycleRunner().run(host, env);
      return { out, env };
    };
    const web = await run('A business website with pages about us, services and contact');
    expect(web.out.artifacts.analysis?.productType).toBe('website');
    expect(web.out.artifacts.generator).toBe('model');
    expect(calls.length).toBeGreaterThan(0);
    const before = calls.length;
    const other = await run(
      'An online store with products, a cart and checkout, sign in, and an admin dashboard',
    );
    expect(other.out.artifacts.analysis?.productType).not.toBe('website');
    expect(other.out.artifacts.generator).toBe('skeleton'); // the default generator
    expect(calls).toHaveLength(before);
    expect(web.out.status).toBe('waiting_approval');
  });

  it('all 14 product types still resolve with and without a registered generator', async () => {
    for (const t of T.planning.PRODUCT_TYPES) {
      const reg = new ProductGeneratorRegistry();
      reg.register('test', [t], gen('g', []));
      expect(reg.asMap().get(t)?.kind).toBe('model');
    }
  });

  it('the loop gives later tasks the contract (exports) of files earlier tasks produced', async () => {
    const seen: { task: string; produced: string[] }[] = [];
    const spy: FileGenerator = {
      kind: 'model',
      async generate(i) {
        seen.push({ task: i.task.id, produced: (i.producedOutlines ?? []).map((o) => o.path) });
        return {
          ops: i.task.files.map((path) => ({
            op: 'add' as const,
            path,
            content:
              path.endsWith('.ts') || path.endsWith('.tsx')
                ? `export const ${path.replace(/\W+/g, '_')} = 1;\n`
                : '{}\n',
          })),
        };
      },
    };
    const host = new MemoryHost();
    const env = new MemoryEnv();
    env.generator = spy;
    await new LifecycleRunner().run(host, env);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]!.produced).toEqual([]);
    expect(seen.at(-1)!.produced.length).toBeGreaterThan(0);
  });
});
