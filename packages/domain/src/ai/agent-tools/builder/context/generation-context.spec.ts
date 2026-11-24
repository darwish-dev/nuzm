import { describe, expect, it } from 'vitest';
import { buildGenerationContext } from './generation-context';
import { entriesFromRepair } from './memory';
import { estimateTokens } from './tokens';

const M = (o: Record<string, string>) => new Map(Object.entries(o));

describe('generation context management', () => {
  it('shows the files the task edits, what they import, and the CONTRACT of files produced earlier in this run', () => {
    const ctx = buildGenerationContext({
      task: { id: 't2', files: ['src/cart/CartPage.tsx'], dependsOn: ['t1'] },
      existing: M({
        'src/cart/CartPage.tsx': "import { money } from '../lib/money';\nexport const x = 1;\n",
        'src/lib/money.ts': 'export const money = (n: number) => n;\n',
        'src/other/zzz.ts': 'export const z = 1;\n',
      }),
      produced: M({
        'src/cart/cart-store.ts':
          'export function addItem(id: string) {}\nexport const items = [];\nconst hidden = 1;\n',
      }),
      memory: '- decision: Stack: Next.js',
      budgetTokens: 4000,
    });
    expect(ctx.excerpts.map((e) => e.path)).toEqual(
      expect.arrayContaining(['src/cart/CartPage.tsx', 'src/lib/money.ts']),
    );
    expect(ctx.producedOutlines).toHaveLength(1);
    expect(ctx.producedOutlines[0]!.outline).toContain('export function addItem(id: string)');
    expect(ctx.producedOutlines[0]!.outline).not.toContain('hidden');
    expect(ctx.memory).toContain('Next.js');
    expect(ctx.report.overBudget).toBe(false);
  });
  it('stays inside its token budget by outlining, then cutting, then dropping the least relevant, and says what it did', () => {
    const big = Array.from({ length: 800 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    const ctx = buildGenerationContext({
      task: { id: 't', files: ['src/a/edit.ts'], dependsOn: [] },
      existing: M({ 'src/a/edit.ts': big, 'src/a/n1.ts': big, 'src/a/n2.ts': big }),
      produced: new Map(),
      memory: 'm '.repeat(500),
      budgetTokens: 1500,
    });
    const used =
      ctx.excerpts.reduce((n, e) => n + estimateTokens(e.text), 0) + estimateTokens(ctx.memory);
    expect(used).toBeLessThanOrEqual(1500);
    expect(ctx.report.steps.length).toBeGreaterThan(0);
  });
  it('produced files close to the task outrank distant ones when the budget is tight', () => {
    const produced = M({
      'src/cart/near.ts': 'export const near = 1;\n',
      'src/billing/far.ts': 'export const far = 1;\n'.repeat(1),
    });
    const ctx = buildGenerationContext({
      task: { id: 't', files: ['src/cart/page.ts'], dependsOn: [] },
      existing: new Map(),
      produced,
      memory: '',
      budgetTokens: 200,
    });
    expect(ctx.producedOutlines.map((o) => o.path)).toContain('src/cart/near.ts');
  });
});

describe('project memory learns error classes, never error text', () => {
  it('turns classes into at most three issue entries and ignores unknown ones', () => {
    const e = entriesFromRepair(
      [
        'undefined_name',
        'undefined_name',
        'type_mismatch',
        'unknown',
        'test_assertion',
        'lint',
        'Bad Class',
      ],
      2,
      '2026-11-24T00:00:00Z',
    );
    expect(e.map((x) => x.kind)).toEqual(['issue', 'issue', 'issue']);
    expect(e[0]!.text).toContain('"undefined_name"');
    expect(e.every((x) => x.source === 'agent')).toBe(true);
    expect(e.some((x) => x.text.includes('unknown'))).toBe(false);
  });
});
