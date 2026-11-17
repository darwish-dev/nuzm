# Guide — residency hooks for later milestones (M04 S14a/S15)

Every module that places data, calls a vendor or calls a model must ask the residency service first.

1. Find your hooks in `spec/compliance/residency-hooks.yaml` (by owner milestone). Each lists where it applies, the data classes, the processor kind and its feature flag.
2. Call `ResidencyService.evaluate({orgId, dataClass, targetRegion, purpose, operation, processorId?})` (or `assertResidency()` / `@RequiresResidency` from `packages/domain`) **before** the action. `deny` and `requires_assessment` stop the action with 422 `residency_denied` and a reason in both languages; any failure to decide is a `deny`.
3. Flip the hook from `listed` to `enforced` in the registry and name the source file (`call_site`) that makes the call. `pnpm compliance:residency-hooks` reads that file and fails if the call is not there.
4. Register your processors in the ROPA (admin console → Compliance → Processing records) and, if a transfer outside the Kingdom is needed, get an approved transfer assessment: an organization relies on one by listing its id in its policy.
5. Register your `DsrHandler` (export, erase, rectify, the datasets you own) in `DsrRegistry`; legal holds and the export archive then include your data.
6. Add a control mapping and, if possible, a collector for your feature.

Until verified provider regions exist (M05), regions come from mock fixtures and an unverified Saudi region is treated as outside the Kingdom.
