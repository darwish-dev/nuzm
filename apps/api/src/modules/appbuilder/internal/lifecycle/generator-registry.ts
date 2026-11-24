import { Injectable } from '@nestjs/common';
import { builderTools } from '@nuzm/domain';
import type { FileGenerator } from './lifecycle.types';

/**
 * Where the website (S04), full-stack (S05) and mobile (S06) tracks plug their generators into the builder loop (P3-S03). The loop owns the lifecycle (requirements → plan → files →
 * build → repair → tests → preview → approval); a track owns HOW the files of its product type are written (templates, framework knowledge, generated tests). A track registers one
 * `FileGenerator` for the product types it serves, once, at module bootstrap; the loop picks it by the plan's product type and falls back to the default generator for every other type
 * (all 14 planners keep resolving whether or not a track registered anything).
 *
 * A registered generator is held to the same rules as the default one and cannot opt out: its ops go through the same validated change (`previewChangeSet`, the secret scan, the safety
 * rules), its model calls (if any) must go through the metered gateway the track is given, and the build/repair loop that follows is the loop's own. Registering is refused for an
 * unknown product type and for a type that already has a generator (two tracks never silently overwrite each other).
 */
@Injectable()
export class ProductGeneratorRegistry {
  private readonly byType = new Map<string, FileGenerator>();
  private readonly owners = new Map<string, string>();

  register(owner: string, productTypes: readonly string[], generator: FileGenerator): void {
    if (productTypes.length === 0)
      throw new Error('a generator must serve at least one product type');
    for (const t of productTypes) {
      if (!(builderTools.planning.PRODUCT_TYPES as readonly string[]).includes(t))
        throw new Error(`unknown product type: ${t}`);
      const had = this.owners.get(t);
      if (had) throw new Error(`product type ${t} already has a generator (registered by ${had})`);
    }
    for (const t of productTypes) {
      this.byType.set(t, generator);
      this.owners.set(t, owner);
    }
  }
  /** the live map the loop reads at run time (a track that registers later is seen by the next run) */
  asMap(): ReadonlyMap<string, FileGenerator> {
    return this.byType;
  }
  ownerOf(productType: string): string | null {
    return this.owners.get(productType) ?? null;
  }
}
