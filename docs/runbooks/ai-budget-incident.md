# Runbook — AI budget or spend incident (M09; DRAFT, owner review pending)

**Signals:** `ai.run.budget_exceeded` audit events spike; `ai.reservation.swept` > 0; a customer reports an unexpected credit drop; `ai.model_usage` credits per hour far above the baseline.
1. **Stop the bleeding (≤ 5 s effect):** admin console → AI → Model providers → *Kill switch* (global) or POST `/v1/admin/ai/model-providers {action:"kill_switch", on:true, orgId?}` for one organization. The next model call answers 503 `ai_unavailable`; runs in flight fail or stop at their next step. Audit: `ai.killswitch.toggled`.
2. **Find the source:** `GET /v1/admin/ai/runs?orgId=…&state=…` (metadata only: kind, tokens, credits, model). Content is NOT visible to support; break-glass with consent is not built.
3. **Check reservations:** `SELECT state, count(*), sum(credits) FROM ai.reservations WHERE org_id=… GROUP BY 1`; held rows older than `expires_at` are released by the sweeper (`AiJobs.tick`).
4. **Check the wallet vs projection:** `ai.credit_balances` is a projection; the truth is ledger account 2100 (`billing.wallet_balances`). Never edit either by hand; corrections are reversing ledger entries through the billing posting service.
5. **Recover:** lift the kill switch after the cause is fixed; ask the customer to lower caps (`PUT /v1/ai/budgets`: dailyCredits, runMaxCredits).
6. Record the incident, the credits affected and any goodwill adjustment (finance, through the adjustment workflow).
