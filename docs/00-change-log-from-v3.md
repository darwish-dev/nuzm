# Change Log — Prompt Pack v3.0 → Revised Plan v4.0-draft

Every reorganization is listed. "Why" cites the approved assessment items (A1–A8) or the owner's requirements (R1–R12 in the revision request).

## 1. Structural changes
| # | Change | Why |
|---|---|---|
| C-01 | Added greenfield bootstrap procedure (`08-bootstrap-greenfield.md`), executed as S01 inside M01 | A1/R1: project directory was empty; v3 assumed an existing monorepo |
| C-02 | Created single-source-of-truth hierarchy (ADRs → `spec/` → docs → prompts → code) and drift checks | R2 |
| C-03 | Shared rules moved out of the 12 prompts into one `CLAUDE.md`; prompts are standalone milestone files that reference it | R11; removes ~45 duplicated lines per file |
| C-04 | **New M02** Ledger, Metering & Entitlements (S05–S07). Ledger skeleton moved out of old M01 | A8/R9: central metering missing; ledger needed depth |
| C-05 | **New M03** Payments, Invoicing, Tax & ZATCA (S08–S12) | A2/R3: no payment/invoice/tax track existed |
| C-06 | **New M04** Saudi Compliance & Data Residency (S13–S15) | A7/R8 |
| C-07 | Old M02 (orchestration) + old M03 (Alibaba/Huawei) + old M04 (Contabo) merged → **M05** Provider Framework & Compute (S16–S23) | One adapter framework and one compute API instead of three overlapping ones (A4) |
| C-08 | Old M05 CloudPanel → M06; old M06 Domains → M07; old M07 Data/Email → M08; old M08 AI/Website → M09 | Re-numbered after inserts |
| C-09 | Old M09 (full-stack app builder) + old M10 (mobile) merged → **M10**, executed as gated M10A/M10B | Keeps 12 milestones as required (R11) while preserving scope |
| C-10 | Old M11 (automation/marketplace/agency) → M11 with **reseller program** added | R4 reseller dashboards; definition of agency vs reseller |
| C-11 | Old M12 → M12 expanded to 4 sprints: pen test, DR and GA package are explicit human/external gates | A6/R10 |
| C-12 | Sprints 43 → 58; calendar 86 → 116 weeks sequential baseline; parallel lanes documented (D-02) | Result of C-04..C-06 and dashboards embedded per milestone |
| C-13 | Dashboards (customer, agency, reseller, admin) specified (`13-dashboards-spec.md`); every milestone lists `UI-Mxx-nn` screens | A3/R4 |
| C-14 | Separated agent-automatable work from human gates (HG-xx) and decisions (D-xx) in every prompt and in the register | R10 |

## 2. API standardization (full mapping in `04 §3`)
Single `/v1/offers`, single `/v1/quotes`, one provisioning path per resource kind, noun sub-resources instead of verbs (`restores`, `renewals`, `approvals`, `executions`), one deploy endpoint, one runs endpoint for all AI generation kinds, `type` on builder projects (website/webapp/mobile), unified location filters (`country`, `region`, `geoGroup`), admin reconciliation moved under `/v1/admin/billing/reconciliations`, single audit endpoint.

## 3. Database de-duplication (full list in `05 §4`)
One audit table, one agent-runs table, one project-file store, one quotes store, one operations table, one financial reconciliation store (`finrec`), deploy tables split out of hosting, mobile projects folded into builder projects, marketplace entitlements exposed to billing through a view.

## 4. Provider strategy
Unchanged: CloudPanel, Alibaba Cloud, Huawei Cloud (Saudi regions only when verified), Contabo (EU, plan-specific capabilities), Openprovider + ResellerClub (optional OpenSRS/CentralNic/eNom/Namecheap/GoDaddy). Added explicit provider-selection decision records for managed databases, Redis, object storage, transactional email and business email (D-05..D-09), all OPEN with proposed defaults and verification probes.

## 5. Scope preserved vs. clarified
No v3 capability was removed. Clarified: marketplace payouts are *deferred pending licensing* (D-26) — revenue accounting remains in scope; app-store submission is *preparation*, not a promise of approval; independent pen test and certifications are external deliverables.

## 6. Items intentionally NOT decided here
Everything listed OPEN in `07-open-decisions-and-blockers.md`.
