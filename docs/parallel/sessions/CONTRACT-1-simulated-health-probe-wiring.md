# CONTRACT-1 — wire `SimulatedHealthProbe` into the app builder's `HealthProbePort` (local reference only)

- Requester: Session 06 (Deployment) · Status: PROPOSED (Master answers ACCEPTED / REVISED / REFUSED here)
- Contract: `HealthProbePort` provider in `apps/api/src/modules/appbuilder/appbuilder.module.ts` (Session 05's file, so the Master merges this one registration)
- Current text: `{ provide: HealthProbePort, useFactory: () => new HttpHealthProbe(async (h) => (await dns.lookup(h, { all: true })).map((x) => x.address)) }` (around line 409)
- Proposed text:
```ts
{
  provide: HealthProbePort,
  useFactory: (cfg: AiConfig) => {
    const real = new HttpHealthProbe(async (h) => (await dns.lookup(h, { all: true })).map((x) => x.address));
    // AI_LOCAL_REFERENCE only (never production): URLs on the reserved .invalid TLD come from the in-memory publisher and are answered SIMULATED; everything else is probed for real
    return cfg.localReference ? new SimulatedHealthProbe(real) : real;
  },
  inject: [AI_CONFIG],
},
```
  plus `import { SimulatedHealthProbe } from '../deploy';` (class is exported from the deploy module's `index.ts`; unit-tested in `deploy/internal/simulated-health.spec.ts`).
- Why: with `AI_LOCAL_REFERENCE=true` the in-memory publisher serves `https://<site>.sites.nuzm.invalid/`; the real probe cannot resolve `.invalid`, so every local web-app deployment ends `failed` (`health_gate_failed`) and the deploy/rollback E2E leg of `10-app-builder` cannot pass. Without this line only the failure case can be exercised in a browser.
- Additive? yes. Production is unchanged (`localReference` is false in production; `UnavailableSitePublisher` still refuses every deployment). The real probe keeps its SSRF rules for every non-`.invalid` URL.
- Tests added: `deploy/internal/simulated-health.spec.ts` (2 tests, passing). E2E `10-app-builder` deploy leg depends on this line (see REPORT-06 heavy-run request).
- Sessions affected: 05 (file), 01 (merge).

## Master answer
(pending)
