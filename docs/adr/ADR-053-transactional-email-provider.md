# ADR-053: D-08 — Transactional email provider

- Status: **Proposed** — drafted by the M08 implementation session for the owner; **NOT accepted, NOT decided.** The agent may propose, never decide (CLAUDE.md §5; docs/14). Nothing in the code depends on this ADR being accepted: the feature flag `data.transactional-email.<provider>` stays OFF until (a) this ADR is accepted by the owner, (b) the adapter probe returns verified capabilities and region for the real account, and (c) HG-08-01 evidence exists. The admin API refuses to enable a provider row without all three (`data.data_providers`, AC-M08-02).
- Related decision: D-08 in `docs/07-open-decisions-and-blockers.md` (OPEN); comparison in `docs/14 §D-08`
- Requirements: FR-DAT-06..09
- Adapter: `TransactionalEmailAdapter` (docs/09 §5), package `@nuzm/adapter-data`

## Context
Managed data services are delivered on the adapter pattern of docs/09 without hardcoding any provider. This record prepares the decision; it asserts NOTHING about what any vendor offers: every claim below is to be established by the probes, with sandbox/test credentials supplied by the owner (HG-08-01), never by the agent.

## Options (all unverified)
(A) managed API provider behind `TransactionalEmailAdapter` — shortlist Amazon SES, Postmark, Mailgun (others allowed by the owner); (B) self-hosted MTA: REJECTED for v1 (reputation, operations) unless the owner reopens; (C) multi-provider failover later.

## Decision criteria (docs/14 §0 weights are proposals; owner may change them)
Domain verification (SPF/DKIM/DMARC), idempotent send, webhooks with signature and replay protection, suppression management, per-organization sender isolation, rate limits and warm-up, data terms (message and log retention, sub-processors, processing location) evaluated by `ResidencyPolicyService` (class `personal`/`customer-content`), metering `email.transactional_messages` on provider acceptance.
Scores stay blank until each cell has an evidence link (probe output, contract clause, documentation URL read on a date). An unscored cell counts 0 and is flagged.

## Probe plan
Per shortlisted vendor, on a sandbox/test account: send with an idempotency key, webhook signature and replay behaviour, bounce/complaint event schema, suppression API, dedicated vs shared IP terms, content/log retention and sub-processor list (contract), sandbox limits, pricing model, per-organization sender-domain isolation.
Order: (1) the owner puts sandbox/test credentials into the NON-production vault; (2) a human triggers the read-only `probe()`; (3) provisioning only after the owner enables the live-verification job; (4) raw evidence is stored redacted; (5) a human signs the evidence index entry. Results are labelled `LIVE-VERIFIED` only with that evidence, otherwise `NOT VERIFIED`.

## Exit conditions
DKIM keys under Nuzm control so that the vendor can be switched; templates are stored in Nuzm.

## Risks
Cross-border processing of personal data (transfer assessment, D-16/HG-04-01); deliverability. Without an approved provider `/v1/email/messages` answers 422 unsupported_capability; system emails of M01 use the dev mail catcher in non-production only.

## Outcomes the code already implements (docs/14 §0)
| Outcome | Behaviour |
|---|---|
| Option verified and approved | Run the conformance suite against the real adapter, then enable through the two-person admin flow |
| Several approved | One primary; the others stay capability-gated and disabled by flag |
| None verified / none approved | The feature is disabled; endpoints answer `422 unsupported_capability`; the UI shows "not available"; M08 acceptance rows stay BLOCKED (never PASS via mocks) |

## Decision
**OPEN.** To be recorded by the owner. The M08 implementation provides dev-reference (mock) adapters for tests only; they are `environment=local`, refused in production, and never evidence.

## Consequences
To be filled in at acceptance.

## Owner / date
OWNER-PLACEHOLDER / —
