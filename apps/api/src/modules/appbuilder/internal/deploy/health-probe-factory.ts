import { promises as dns } from 'node:dns';
import { SimulatedHealthProbe } from '../../../deploy';
import { HttpHealthProbe, type HealthProbePort } from './ports';

/**
 * The health probe the web-app deployment gate uses. The REAL probe (with its SSRF rules) is the default. Only the local reference (`AI_LOCAL_REFERENCE=true`, which `loadAiConfig`
 * already forces to false in production) wraps it in the `SimulatedHealthProbe`, which answers SIMULATED for the reserved `.invalid` names the in-memory publisher serves and
 * passes every other URL to the real probe. `resolve` is replaceable for tests.
 */
export function healthProbeFor(
  cfg: { localReference: boolean },
  resolve: (host: string) => Promise<string[]> = async (h) =>
    (await dns.lookup(h, { all: true })).map((x) => x.address),
): HealthProbePort {
  const real = new HttpHealthProbe(resolve);
  return cfg.localReference ? (new SimulatedHealthProbe(real) as unknown as HealthProbePort) : real;
}
