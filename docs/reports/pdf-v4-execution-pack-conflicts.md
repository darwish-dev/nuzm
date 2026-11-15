# Conflict analysis — `Cloud_AI_All_12_Milestones.pdf` ("Corrected Execution Pack V4.0") vs approved docs v4.0-draft

Source: owner attached the PDF on 2026-11-15 with "Start building the milestone step by step." Treated as **data from the owner, not as an approved replacement**, because it contradicts decisions already approved in `HG-00-01-approval.md`. Per `CLAUDE.md §2`, conflicts are recorded here and no code is written against either side until the owner chooses.

## Direct conflicts (change public contracts or milestone order)
| # | Topic | PDF | Approved docs | Where |
|---|---|---|---|---|
| 1 | Sprint/milestone plan | 12 milestones, 43 sprints, original v3 order (M02 provider orchestration, M03 Saudi ECS, M04 Contabo …) | 12 milestones, 58 sprints; new M02 ledger/metering, M03 payments/ZATCA, M04 compliance; compute merged into M05 | docs/03, 06 |
| 2 | Compute API | **Forbids** `/v1/compute/instances`; use `/v1/cloud/resources`, `/v1/cloud/resources/{id}/actions` | `/v1/compute/instances` typed API; `/v1/resources` read-only inventory; no `/v1/cloud/resources` | docs/04 §2.5, §3 |
| 3 | Offers/quotes | `/v1/catalog/offers`, `/v1/cloud/quotes`, `/v1/domains/quotes` | `/v1/offers`, single `/v1/quotes` | docs/04 |
| 4 | Data APIs | `/v1/data/databases`, `/v1/data/caches` | `/v1/databases` (engine incl. redis) | docs/04 §2.8 |
| 5 | AI/builder APIs | `/v1/ai/jobs`, `/v1/ai/artifacts`, `/v1/builds`, `/v1/apps`, `/v1/automations` | `/v1/ai/runs`, `/v1/builder/projects`, `/v1/deployments`, `/v1/workflows` | docs/04 §2.9–2.11 |
| 6 | Domains | `/v1/domains/orders`, `/v1/domains/{id}/dns`, `/v1/domains/{id}/transfers` | `POST /v1/domains` (from quote), `/v1/dns/zones/{id}/records`, `/v1/domains/transfers` | docs/04 §2.7 |
| 7 | Billing | `/v1/billing/usage`, `/v1/billing/reconciliation`, `/v1/billing/refunds` | `/v1/usage`, `/v1/admin/billing/reconciliations`, `/v1/admin/billing/refunds` | docs/04 §2.2–2.3 |
| 8 | Audit | `/v1/admin/audit-events`, `/v1/audit-events` | `/v1/audit-logs`, `/v1/admin/audit-logs` (same single store in both) | docs/04 §2.1 |
| 9 | Error envelope | `{code,message,requestId,details}` | RFC 9457 problem+json with `traceId` | docs/04 §1 |
| 10 | Async mutation response | `{operationId,resourceId?,status}` | `202` + Operation resource | docs/04 §1 |
| 11 | Durable workflows | Temporal (or ADR alternative) recommended | Outbox + BullMQ proposed; D-03 OPEN | docs/02, 07 |
| 12 | Commerce timing | Full order→quote→tax→payment→invoice→ledger sandbox checkout **inside M01** | Ledger/plans in M02, payments/invoices/tax/ZATCA in M03 (S08–S12) | docs/06 |
| 13 | UI timing | Billing entry/plans in M01, catalog/quote in M02, inventory M03–M04 … admin in M12 | Shells in M01; each milestone owns its screens (215 indexed) | docs/13 |
| 14 | Spec locations | `packages/contracts/openapi.yaml`, `docs/implementation/`, `docs/architecture/`, `docs/providers/` | `spec/openapi/`, `docs/` flat | docs/02, 08 |
| 15 | Roles | owner/admin/developer/billing/viewer | owner/admin/billing_admin/developer/viewer | docs/01 |

## Compatible or additive (adoptable without conflict)
Provider IDs only in mapping tables · soft-delete/tombstone policy · resource hierarchy user→org→workspace→project→environment→resource · metering event fields (`providerEventId`, `pricingVersion`, `ingestedAt`) · SAST/branch protection/secret scanning · Apple/Google in-app-purchase policy assessment for mobile sales · state names `DRAFT/QUOTED/AWAITING_PAYMENT/PROVISIONING/ACTIVE/FAILED/DELETING/DELETED/UNKNOWN` · "100 concurrent identical idempotency-key requests create exactly one resource" acceptance test · 10k-tenant synthetic load plan · `docs/milestones/Mxx-REPORT.md` naming · PRD source handling (copy PRD v2.0 into `docs/source/`; note the referenced `.docx` is still not supplied).

## Missing from the PDF (present in approved docs)
Saudi compliance milestone and residency engine · ZATCA implementation track · standalone reseller dashboard · provider-selection decision records D-05..D-09 with probes · PA/SCR change-request process · RC/TR reconciliation classes · decision/blocker register.

## Not in either source
`Cloud_AI_Full_Platform_PRD_Milestones_v2.docx` (named as source of truth by both packs) has never been supplied.

## Decision (owner, 2026-11-15, via per-cluster questions)
| Cluster | Rows | Outcome |
|---|---|---|
| Plan and commerce timing | 1, 12, 13 | **Approved docs win**: 58 sprints; payments/invoicing in M03 |
| Resource API paths | 2–8, 14 | **Approved paths win**; no PDF aliases; specs under `spec/openapi/` |
| Error format / async | 9, 10 | **Approved wins**: problem+json, `202` + Operation |
| Engine / roles / layout | 11, 15 (+14 layout) | **Approved wins**: D-03 stays OPEN; `billing_admin`; docs flat |

## Adopted additive items (applied 2026-11-15)
docs/05 §9 (hierarchy, provider-id mapping rule, canonical resource states, tombstones) · docs/12 §2 (`providerEventId`, `tags`, `pricingVersion`, `receivedAt`≡`ingestedAt`) · M05 AC-M05-22..24 (100-concurrent idempotency, UNKNOWN reconcile, state-machine check) · M10 AC-M10-17 (in-app-purchase policy assessment, legal). Not adopted: all 15 conflict rows above, Temporal as the decided engine, 43-sprint plan. Still unactioned (nice-to-have): 10k-tenant synthetic load plan (M12 already has a load-test task; sizing to be set with D-02/D-30), `docs/source/` PRD copy (blocked: the `.docx` was never supplied).

