import type { ModelAdapter } from '@nuzm/adapter-model';

/** Adapter instances by provider code. EMPTY in production until a provider is decided, probed, attested and enabled (D-18, HG-09-01). */
export abstract class ModelAdapterRegistry {
  abstract get(code: string): ModelAdapter | undefined;
  abstract codes(): string[];
}
export class StaticModelAdapterRegistry extends ModelAdapterRegistry {
  private readonly m = new Map<string, ModelAdapter>();
  register(code: string, a: ModelAdapter) {
    this.m.set(code, a);
  }
  get(code: string) {
    return this.m.get(code);
  }
  codes() {
    return [...this.m.keys()];
  }
}
