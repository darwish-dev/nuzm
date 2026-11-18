# Runbook — email deliverability and throttling (M08)

Scope: transactional email only (marketing/bulk is blocked by policy). No provider is selected (D-08 OPEN); dev-reference mock only.

**Guardrails (proposal values, tunable via environment):** per-organization rate `EMAIL_RATE_PER_MINUTE`; warm-up daily allowance `EMAIL_WARMUP_BASE_PER_DAY` doubling per day since the first verified sending domain, capped by `EMAIL_MAX_PER_DAY`; **auto-throttle** when the rolling 24 h bounce rate exceeds 5% or the complaint rate 0.1% (minimum sample 20). A throttled organization gets `429 rate_limited` with `throttled:true`.

1. See the rates: `MessageService.rates(orgId)` (service API; the admin view is the proposed PA-19).
2. Find the cause: bounce events by type (`GET /v1/email/events?type=bounce_hard`), the sender domain's DNS state (`/v1/email/domains`), DMARC state (guidance only, start `p=none`).
3. **Override** (time-boxed, audited as `email.throttle.override`) only with a documented reason: `MessageService.setThrottleOverride(orgId, actor, untilIso)`. It lifts the warm-up cap and the auto-throttle, never the per-minute rate or the suppression rules.
4. A real provider's own sending limits and reputation rules are NOT modelled here: they need HG-08-01 and the provider's documentation.
