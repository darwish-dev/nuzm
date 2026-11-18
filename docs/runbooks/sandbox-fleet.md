# Runbook — sandbox fleet (M10A)
- Flag: `app_builder.enabled` (platform.feature_flags). Production with no isolating runtime answers 503 `sandbox_no_capacity` by design.
- Reaper/meter: `SandboxJobs.tick()` every 60 s (idle 30 min, max 4 h); metering `ai.sandbox_cpu_seconds`, event id per (sandbox, minute window), cumulative `cpu_metered` makes the sum equal the runtime total.
- Quota full (409): list `builder.sandboxes` by org/state; terminate via DELETE; never delete rows (records are immutable).
- Canary alert (`canary_triggered`): treat as a security incident: terminate the sandbox, preserve logs, notify security; the escape suite must be re-run.
- Force-kill from the admin console is hidden until its spec change is approved (no endpoint in docs/04).
