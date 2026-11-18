# Runbook — workflow abuse and runaway automation (M11)

Owner: platform operations. Status: DRAFT (M11; the admin read endpoints are SCR-M11-05, not approved — until then use the SQL in step 2 through the break-glass role, audited).

## Signals
- Notification `automation.workflow_paused` to the organization's automation managers; audit `workflow.workflow.auto_paused` (failure outcome) with `detail.kind`.
- `automation.anomaly_cases` rows with `status = 'open'` (kinds `execution_spike`, `high_4xx_rate`, `recursion`, `connector_failures`, `kill_switch`).
- Webhook endpoint auto-paused after 50 consecutive failures: audit `webhook.endpoint.auto_paused`.
- Dead letters piling up: `SELECT org_id, count(*) FROM automation.dead_letters WHERE replayed_at IS NULL GROUP BY 1`.

## Rules the platform applies by itself
| Rule | Default | Effect |
|---|---|---|
| Execution spike | > 300 executions of one workflow in 60 s (`AUTOMATION_SPIKE_PER_MINUTE`) | workflow paused, case opened, managers notified |
| High 4xx share | > 80 % of the last 20 HTTP/Nuzm-API step attempts (`AUTOMATION_HTTP_4XX_RATE`, `AUTOMATION_RATE_WINDOW`) | same |
| Chain depth | event chain deeper than 5 (`AUTOMATION_MAX_CHAIN_DEPTH`) | trigger skipped, workflow paused (recursion case) |
| Concurrency | 10 running executions per organization (`AUTOMATION_MAX_CONCURRENT`) | further executions are deferred (not dropped) |
| Start rate | 600 starts/min per organization | 429 `rate_limited` |
| Connector | token bucket per connector + circuit breaker (5 failures → open 60 s) | step retries with backoff |

## Procedure
1. **Triage.** Read the case `details` (counts, window) and the workflow's last executions (`GET /v1/workflow-executions/{id}` as the organization, or SQL). Check whether the trigger is a platform event that the workflow itself causes (self-trigger) or an external webhook flood.
2. **Pause or kill.** The organization can pause (`PATCH /v1/workflows/{id}` `status: paused`). To stop it for them: `WorkflowService.adminPause(workflowId, orgId, reason, adminUserId)` (admin pause; the organization cannot lift it; audited `workflow.workflow.admin_paused`). Global switch: set `automation.enabled` to `false` in `platform.feature_flags` (org row = one organization; global row = everyone). Running executions stop at their NEXT step (the engine re-reads the workflow status before every step); queued ones are cancelled when claimed.
3. **Stop outbound abuse.** Revoke the connector authorization (`ConnectorService.revoke`) — executions fail closed at the next step; add the host to the organization's egress deny list (`platform.feature_flags` key `automation.egress`, value `{"deny":["host"]}`); pause or disable the webhook endpoint.
4. **Dead letters.** Never bulk-replay. A dead letter with reason `uncertain_outcome` means a non-idempotent step was interrupted: reconcile with the target system first, then replay (`ExecutionService.replay`, idempotent on the dead-letter id; the replay keeps the original idempotency keys).
5. **Close.** Resolve the case (`UPDATE automation.anomaly_cases SET status = 'resolved', resolved_by, resolved_at`) with a note in the incident record. Tell the customer what happened and what they must change (rate, recursion, bad URL).
6. **Evidence.** Keep audit rows (`workflow.*`, `connector.*`, `webhook.*`) and the case; execution inputs/outputs are secret-redacted `customer-content` (retention per D-34, erased by DSR once the DSR handler exists — see M11-report §G).

## Do not
- Do not read execution inputs for curiosity (customer content, may be personal data).
- Do not switch off the SSRF guard or raise the 5 MB / 30 s limits to "make a customer's workflow work".
