/** The shape of the web-app health gate's probe (`HealthProbePort` in the app builder); structural so the deploy module needs no import from the app builder. */
export interface HealthProbeLike {
  check(url: string): Promise<{ ok: boolean; status: number | null; detail: string }>;
}

/**
 * Health probe for the LOCAL REFERENCE (`AI_LOCAL_REFERENCE=true`, never production): a URL on the reserved `.invalid` TLD can only have come from the in-memory site
 * publisher (a real node never serves such a name and the TLD never resolves), so the probe answers 200 for it and says so: SIMULATED, NOT a probe of anything. Every
 * other URL goes to the real probe unchanged, so its SSRF rules still apply. Without this, a local deployment can never pass the health gate (the real probe cannot
 * resolve `.invalid`) and the deploy and rollback flows could not be exercised end to end.
 */
export class SimulatedHealthProbe implements HealthProbeLike {
  constructor(private readonly inner: HealthProbeLike) {}
  async check(url: string) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      /* not a URL: the real probe refuses it */
    }
    if (host.endsWith('.invalid'))
      return { ok: true, status: 200, detail: 'SIMULATED: local stand-in answer, no request was made' };
    return this.inner.check(url);
  }
}
