import type { BillLine } from './reconcilers';

/**
 * Provider bill sources for RC-04 (docs/11 §7). Each provider module (compute M05, domains M07, ...) registers one function that returns the
 * provider's bill lines for [from, to] (inclusive dates), or null when it has no bill source. `collect` is null only when NO module has one.
 */
export type BillSource = (from: string, to: string) => Promise<BillLine[] | null>;
export class BillSourceRegistry {
  private readonly sources = new Map<string, BillSource>();
  register(name: string, source: BillSource): void {
    this.sources.set(name, source);
  }
  async collect(from: string, to: string): Promise<BillLine[] | null> {
    if (this.sources.size === 0) return null;
    const parts = await Promise.all([...this.sources.values()].map((s) => s(from, to)));
    const have = parts.filter((p): p is BillLine[] => p !== null);
    return have.length ? have.flat() : null;
  }
}
