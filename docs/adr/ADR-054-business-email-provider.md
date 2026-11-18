# ADR-054: D-09 — Business email (mailbox) provider

- Status: **Proposed** — drafted by the M08 implementation session for the owner; **NOT accepted, NOT decided.** The agent may propose, never decide (CLAUDE.md §5; docs/14). Nothing in the code depends on this ADR being accepted: the feature flag `data.mailbox.<provider>` stays OFF until (a) this ADR is accepted by the owner, (b) the adapter probe returns verified capabilities and region for the real account, and (c) HG-08-01 evidence exists. The admin API refuses to enable a provider row without all three (`data.data_providers`, AC-M08-02).
- Related decision: D-09 in `docs/07-open-decisions-and-blockers.md` (OPEN); comparison in `docs/14 §D-09`
- Requirements: FR-DAT-04, FR-DAT-05
- Adapter: `MailboxAdapter` (docs/09 §5), package `@nuzm/adapter-data`

## Context
Managed data services are delivered on the adapter pattern of docs/09 without hardcoding any provider. This record prepares the decision; it asserts NOTHING about what any vendor offers: every claim below is to be established by the probes, with sandbox/test credentials supplied by the owner (HG-08-01), never by the agent.

## Options (all unverified)
(A) resell the email products of existing registrar partners (ResellerClub/Openprovider: availability and API to be verified); (B) Google Workspace / Microsoft 365 reseller programs (eligibility to be verified); (C) self-hosted mail: REJECTED for v1. Docs/07 default: A, fallback B.

## Decision criteria (docs/14 §0 weights are proposals; owner may change them)
Mailbox and alias lifecycle by API or reseller-console automation, quota and storage metering (`email.mailbox_months`, `email.mailbox_storage_gb_months`), MX/SPF/DKIM/DMARC requirements returned declaratively for M07, deletion/erasure, tenant isolation, data terms/location, password handling by reset link or one-time secret (no persisted plaintext).
Scores stay blank until each cell has an evidence link (probe output, contract clause, documentation URL read on a date). An unscored cell counts 0 and is flagged.

## Probe plan
Product catalogue via the registrar sandbox, documented provisioning methods, idempotency/lookup by name, suspension/deletion semantics, usage reporting, data location per contract, migration/export options, white-label constraints.
Order: (1) the owner puts sandbox/test credentials into the NON-production vault; (2) a human triggers the read-only `probe()`; (3) provisioning only after the owner enables the live-verification job; (4) raw evidence is stored redacted; (5) a human signs the evidence index entry. Results are labelled `LIVE-VERIFIED` only with that evidence, otherwise `NOT VERIFIED`.

## Exit conditions
IMAP/MX-based migration; DNS control stays with Nuzm (M07).

## Risks
Limited reseller email APIs; support burden; data location. Without a verified provider the mailbox feature is disabled; sender-domain features (D-08) are independent.

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
