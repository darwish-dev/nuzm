# Runbook — E-invoice queue stuck or failing (M03 S11b) — SIMULATED ONLY

Console: `GET /v1/admin/billing/zatca/submissions` (finance, security) and `POST …/{id}/retry` (finance, step-up). Everything refers to the simulated server (`NOT VERIFIED vs ZATCA`).

## 1. Reading the queue
Each document has a current state: `generated` (waiting for credentials) → `stamped` → `queued` → `submitted` → `cleared` (standard) / `reported` (simplified), or `rejected`, or `error` (dead letter). A `queued` document with `lastError` has failed before and waits for `nextAttemptAt` (exponential backoff: 60 s, 120 s, 240 s, … from `ZATCA_BACKOFF_SECONDS`; dead letter after `ZATCA_MAX_ATTEMPTS`, default 6).
| You see | Meaning | Action |
|---|---|---|
| many `generated` | no production credential yet | finish the onboarding (`zatca-onboarding.md`) |
| `queued` + `unavailable` | the server did not answer (nothing happened) | wait; an alert `zatca.clearance_unavailable` was raised; standard invoices stay held (not delivered) until cleared |
| `queued` + `timeout` | the answer was lost; the platform **asks the server about the document first** and adopts a decision that exists (never resubmits a decided document) | wait |
| `error` + `deadLetter` | all attempts used | fix the cause, then **retry** (fresh attempt budget); retrying is idempotent per document |
| `rejected` | the server refused the document (`lastError` has the codes) | **final.** Not retryable: needs human review. Correct through a credit note and a new invoice (docs/11), never by resubmitting an altered document |
| `windowAlert` / `windowBreached` (simplified) | more than 50% / 100% of the reporting window has passed without a report | escalate: check the server, credentials and the scheduler |

## 2. Is the scheduler running?
The e-invoicing step runs inside the billing scheduler tick (`BILLING_SCHEDULER_INTERVAL_SECONDS`, off by default, ADR-017). No tick, no submissions. A single tick can be run by an operator through the application's scheduler; ticks are idempotent and serialized by an advisory lock.

## 3. Never
- Edit documents, hashes, counters or the chain: the database refuses it, and a gap or a changed body is a compliance incident.
- Retry a `rejected` document, or resubmit a `cleared`/`reported` one.
- Copy the contents of the vault into a ticket or chat.
