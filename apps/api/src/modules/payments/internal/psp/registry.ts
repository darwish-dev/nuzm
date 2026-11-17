import type { PspAdapter } from './psp';

/** Adapters by provider name (the `{provider}` of the webhook route). An unknown provider is simply not found. */
export class PspRegistry {
  private readonly adapters = new Map<string, PspAdapter>();
  register(a: PspAdapter): void {
    if (this.adapters.has(a.provider))
      throw new Error(`a PSP adapter for ${a.provider} is already registered`);
    this.adapters.set(a.provider, a);
  }
  find(provider: string): PspAdapter | undefined {
    return this.adapters.get(provider);
  }
  /** The adapter new payment methods and payments use (one active PSP account until D-10 chooses). */
  primary(): PspAdapter {
    const a = [...this.adapters.values()][0];
    if (!a) throw new Error('no PSP adapter is configured');
    return a;
  }
}
