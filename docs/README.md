# Nuzm Documentation Index (v4.0-draft — awaiting owner review)

**No implementation may begin until the owner records approval (HG-00-01) in `docs/reports/`.** Start with `07 §D` (review checklist).

## Read in this order
| # | File | What it is |
|---|---|---|
| — | `../CLAUDE.md` | Shared agent rules (replaces the repeated header of the old 12 prompts) |
| 00 | `00-change-log-from-v3.md` | Every reorganization vs the v3 prompt pack |
| 01 | `01-master-prd.md` | Revised master PRD, requirement IDs, NFR targets |
| 02 | `02-system-architecture.md` | Revised architecture and proposed ADR list |
| 03 | `03-milestone-dependency-matrix.md` | Milestones, hard/soft dependencies, lanes, gates |
| 04 | `04-unified-api-specification.md` | Authoritative endpoint catalogue + proposed additions (PA-xx) |
| 05 | `05-database-ownership-and-migrations.md` | Schema ownership, de-duplication, migration ranges, reconciliation classes |
| 06 | `06-sprint-roadmap.md` | 58-sprint roadmap |
| 07 | `07-open-decisions-and-blockers.md` | Decisions (D-xx), human gates (HG-xx), approval checklist |
| 08 | `08-bootstrap-greenfield.md` | Greenfield bootstrap (Sprint S01) |
| 09 | `09-provider-adapter-interfaces.md` | CloudPanel / Alibaba / Huawei / Contabo / registrar / data / PSP / ZATCA / model adapter contracts |
| 10 | `10-saudi-compliance-track.md` | PDPL, residency, NCA/CST, validation (applicability to be confirmed by counsel) |
| 11 | `11-payments-billing-zatca-track.md` | Payments, subscriptions, invoicing, VAT, ZATCA, reconciliation RC-01..06 |
| 12 | `12-metering-spec.md` | Central usage metering, meter catalogue |
| 13 | `13-dashboards-spec.md` | Customer/agency/reseller/admin dashboards + generated screen index (215 screens) |
| 14 | `14-provider-selection-decisions.md` | Decision records D-05..D-10, D-18 |
| M01–M12 | `milestones/` | Twelve standalone milestone prompts (15 fixed sections each) |

## Source-of-truth precedence
Accepted ADRs and recorded decisions → `spec/` (after bootstrap) / docs 03,04,05 (before) → docs 01,02,06,10–14 → milestone prompt → code. Conflicts are reported, never silently resolved.

## Known open items in this draft set
1. Proposed endpoint additions PA-01..PA-16 (doc 04 §2.13): milestone prompts reference them as SCR-xx where they depend on them; those screens/criteria are BLOCKED until approved and merged into doc 04.
2. Per-milestone "Spec issues found" lists at the end of each prompt were reconciled in docs 01–07 on drafting; re-check after owner edits.
3. Every D-xx in doc 07 is OPEN; proposed defaults are recommendations only. No provider capability, region, certification, approval or regulatory fact is asserted anywhere in these documents.
