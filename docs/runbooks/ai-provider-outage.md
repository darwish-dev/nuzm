# Runbook — model provider outage or data-terms change (M09; DRAFT)

**Outage:** the gateway retries a retryable error once on the same reservation, then falls back to the next ALLOWED candidate (same residency, same data-terms rule, own reservation); if none remains the call answers 503 `service_unavailable` and the run fails with a clear code (no spend: reservations are released).
1. Confirm in `ai.model_usage` (`outcome='error'`, `error_code`, `provider_code`) which provider fails.
2. If a fallback provider exists and is attested, nothing to do. Otherwise *disable* the failing provider in the admin console (action `disable`) to stop the retries, or use the kill switch for a full stop.
3. **Never enable a provider to restore service without its attestation (HG-09-01) and a second approver.** Changing a provider's region or rate card disables it and drops the region-bound attestation by design.
4. **Data-terms change at the vendor:** disable the provider, record a new attestation only after the human review; the old attestation reference stays in the audit trail.
5. After recovery run the conformance suite (`runModelConformance`) against the adapter before re-enabling.
