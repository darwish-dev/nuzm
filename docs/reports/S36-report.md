# S36 report — transactional email and acceptance

Status: **DONE for the autonomous scope; live rows BLOCKED** · Branch `claude/m08-data-email-b74780` · Written 2026-11-18 · Dev-reference mocks only: **NOT VERIFIED (local reference)**; production providers BLOCKED (D-05..D-09 OPEN, HG-08-01 PENDING).

## A. Repository findings and assumptions
- No transactional provider is selected (D-08 OPEN). The mock provider's webhook scheme is Nuzm's own fixture, not any vendor's. `POST /v1/email/suppressions` also removes (`action:'remove'`) because docs/04 lists no DELETE.

## B. Plan and changed files
- `sanitize.ts`, `template.ts`, `sender-template.service.ts`, `suppression.service.ts`, `message.service.ts`, `email-webhooks.controller.ts`, `forms-notification.port.ts`; runbooks; `sanitize.spec.ts` (56 cases incl. XSS corpus + 1000-case fuzz).

## C. Implemented features, API and UI screens
- `POST /v1/email/messages` (Idempotency-Key mandatory; only `category=transactional`; max 10 recipients; verified sender; suppression check; header injection and HTML sanitized; residency; rate / warm-up / auto-throttle guardrails with admin override service); `GET /v1/email/messages[/{id}]`, `/events`, `/templates`, `/sender-identities`, `/suppressions`.
- `POST /v1/webhooks/email/{provider}`: signature over the raw body + replay window, dedupe per provider event id, hard bounce/complaint ⇒ suppression in the same transaction (≤ the request), soft bounce policy 3 in 72 h, state never regresses.
- Meter `email.transactional_messages` only on provider acceptance (also from a webhook when the answer was lost; deterministic event id). Bodies: hash at rest; sealed queue buffer; N-day retention only if the organization enabled it; recipients sealed + hashed. Usage vs provider reconciliation (1% proposal). `FormsNotificationPort` for M09.

## D. Migrations and rollback
- none beyond 1003.

## E. Tests run with actual results
- `email.int.spec.ts`: 31 cases (see the M08 report for totals). Highlights: duplicate webhook ×100 ⇒ 1 event / 1 suppression / 1 meter; hard bounce ⇒ suppression and 20/20 suppressed sends blocked; replay ⇒ one provider call; provider timeout after acceptance ⇒ reconcile ⇒ one send.

## F. Security, tenant isolation, billing, residency verification
- ≥120 email isolation cases, 0 successes; header-injection fuzz; template XSS fuzz; residency denial for domains/sends; no plaintext address/body in any column (test).

## G. Human gates and live checks still needed
- D-08/HG-08-04 (provider, sending domain, warm-up plan, abuse policy), HG-04-01 (counsel), D-34 (retention), D-31 (tolerance). DSR export/erase handler for messages and suppressions is NOT implemented.

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M08-07 (duplicate webhooks ×100 ⇒ 1/1/1) | PASS (dev-reference) |
| AC-M08-08 (hard bounce ⇒ suppressed ≤60 s; suppressed send blocked 100%) | PASS (dev-reference) |
| AC-M08-11 (real send delivered, real webhooks) | BLOCKED (HG-08-01, D-08) |
| AC-M08-14 (metering vs provider within D-31) | BLOCKED (D-31, HG-08-01); the reconciliation mechanism is tested on the mock |

## I. Next-sprint handoff and open decisions
- M09 uses `FormsNotificationPort`; M12 consumes `ops.alert` events and the drill results.
