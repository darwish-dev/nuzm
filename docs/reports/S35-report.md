# S35 report — business email

Status: **DONE for the autonomous scope; live rows BLOCKED** · Branch `claude/m08-data-email-b74780` · Written 2026-11-18 · Dev-reference mocks only: **NOT VERIFIED (local reference)**; production providers BLOCKED (D-05..D-09 OPEN, HG-08-01 PENDING).

## A. Repository findings and assumptions
- No mailbox provider is selected (D-09 OPEN), M07 is not on this base: DNS linkage is a port (`DnsLinkagePort`, assumptions U-15). DNS verification reads public resolvers; tests use fixtures.

## B. Plan and changed files
- Migration 1003 (email schema), `dns.ts` (live verification with majority of resolvers), `domain.service.ts`, `mailbox.service.ts`, `email-pricer.ts`, `email.controller.ts`, `email.int.spec.ts`, `dns.spec.ts`.

## C. Implemented features, API and UI screens
- `POST/GET /v1/email/domains`, `POST /v1/email/domains/{id}/verification` (records declared by the adapters + Nuzm's per-organization ownership TXT + one merged SPF + DMARC guidance `p=none`); verification needs DNS (majority of resolvers) AND the provider's own confirmation; TTL-aware retries; `domain_not_owned` for a domain another account verified; one-click apply through `DnsLinkagePort`.
- `POST/GET /v1/email/mailboxes`, `PATCH/DELETE …/{id}`, `POST/GET /v1/email/aliases`: durable operations, reconcile-before-retry, password setup straight into the vault (kind visible only), reveal service (PA-19 not exposed), quotas by entitlement, residency.
- Metering `email.mailbox_months` (1/30 per active day) and `email.mailbox_storage_gb_months` (provider usage; unreportable ⇒ unavailable).

## D. Migrations and rollback
- `1003__email__domains_mailboxes_messages` (+ `.down.sql`, DEV ONLY).

## E. Tests run with actual results
- `dns.spec.ts` 18 cases (missing/duplicate SPF, DKIM selectors, DMARC variants, MX set, resolver majority/disagreement/failure); `email.int.spec.ts` mailbox, alias, reconcile and metering cases.

## F. Security, tenant isolation, billing, residency verification
- Ownership proof is bound to the organization (another organization's DNS token does not verify); one verified claim per domain (unique index); residency evaluated before the provider hears about the domain (personal class).

## G. Human gates and live checks still needed
- D-09/HG-08-03 (mailbox provider, reseller access), D-08 (domain records at the transactional provider), M07 for one-click apply, HG-04-01 (counsel: email metadata/content transfer).

## H. Acceptance checklist
| Row | Status |
|---|---|
| AC-M08-10 (DNS verification on a REAL domain with the REAL provider) | BLOCKED (HG-08-01, D-08/D-09, M07); fixture checks PASS (NOT VERIFIED live) |

## I. Next-sprint handoff and open decisions
- S36 adds senders, templates, messages, webhooks, guardrails on the same module.
