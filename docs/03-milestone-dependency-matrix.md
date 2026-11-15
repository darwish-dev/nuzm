# Nuzm — Milestone Dependency Matrix (draft)

Legend: **H** hard dependency (cannot start the dependent sprint without it done and approved) · **S** soft dependency (can start with a mocked interface; acceptance needs the real one) · `—` none. Machine-readable copy will be `spec/milestones/milestones.yaml` (bootstrap); CI validates it is acyclic and that prompts reference it.

## 1. Milestones
| ID | Name | Sprints | Sprint count |
|---|---|---|---|
| M01 | Bootstrap, IAM, Tenancy & Portal Shells | S01–S04 | 4 |
| M02 | Ledger, Metering & Entitlements | S05–S07 | 3 |
| M03 | Payments, Invoicing, Tax & ZATCA | S08–S12 | 5 |
| M04 | Saudi Compliance & Data Residency | S13–S15 | 3 |
| M05 | Provider Framework & Compute (Alibaba, Huawei, Contabo) | S16–S23 | 8 |
| M06 | CloudPanel Shared Hosting | S24–S27 | 4 |
| M07 | Domains & DNS Reseller | S28–S31 | 4 |
| M08 | Managed Data & Email | S32–S36 | 5 |
| M09 | AI Core & Website Builder | S37–S41 | 5 |
| M10 | Full-stack AI App Builder & Mobile Builder | S42–S50 | 9 (gated as M10A S42–S47, M10B S48–S50) |
| M11 | Automation, Marketplace, Agency & Reseller Programs | S51–S54 | 4 |
| M12 | Enterprise, Hardening & Launch | S55–S58 | 4 |

## 2. Dependency matrix (row depends on column)
|  | M01 | M02 | M03 | M04 | M05 | M06 | M07 | M08 | M09 | M10 | M11 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **M02** | H |  |  |  |  |  |  |  |  |  |  |
| **M03** | H | H |  |  |  |  |  |  |  |  |  |
| **M04** | H | S |  |  |  |  |  |  |  |  |  |
| **M05** | H | H | H | H |  |  |  |  |  |  |  |
| **M06** | H | H | S | H | H |  |  |  |  |  |  |
| **M07** | H | H | H | H | H | S |  |  |  |  |  |
| **M08** | H | H | S | H | H | S | H |  |  |  |  |
| **M09** | H | H | S | H | S | H | S | S |  |  |  |
| **M10** | H | H | — | H | H | H | S | H | H |  |  |
| **M11** | H | H | H | S | — | — | — | — | H | S |  |
| **M12** | H | H | H | H | H | H | H | H | H | H | H |

Notes on non-obvious entries:
- M05 needs **M03** because paid provisioning requires payment-method/authorization and invoicing hooks; and **M04** because routing must call the residency policy engine.
- M06 needs M05 for the VPS nodes that host CloudPanel; M03 is soft (hosting billing can start with ledger-only until payments land, but acceptance requires invoices).
- M07's hosting-linkage acceptance requires M06; everything else in M07 can proceed after M05.
- M08 email domain verification uses M07 DNS; database/bucket hosting uses M05 compute and the provider framework.
- M09 publishing requires M06 (hosting target); custom domain requires M07 (soft until acceptance); forms/CMS/transactional email use M08 (soft).
- M10 sandbox runners require M05 compute; generated apps use M08 databases; deploy uses M09 pipeline.
- M11 marketplace purchases require M03; agency/reseller billing reuses M02/M03 and `billing_entities` (D-24).
- Compliance (M04) obligations continue as **acceptance rows in every later milestone** ("Compliance hooks" section in each prompt).

## 3. What each milestone produces that others consume
| Milestone | Produces (contract) | Consumed by |
|---|---|---|
| M01 | Auth/org context, RBAC, `platform.operations`, outbox, idempotency, audit, notifications, portal shells, design system | all |
| M02 | `LedgerPostingService`, `MeteringIngestService`, price books/rating, entitlements/quota check, `commerce.quotes`, spend approval | M03, M05–M11 |
| M03 | Payment intents, subscriptions, invoices, VAT, ZATCA submit, `finrec` framework | M05–M11, M12 |
| M04 | `ResidencyPolicyService`, consent/DSR services, retention/legal hold, control register, evidence collectors | M05–M12 |
| M05 | `ProviderAdapter` + conformance kit, vault refs, catalog/capabilities, routing, compute API, reconciler | M06–M10, M12 |
| M06 | Hosting site API, node agent/CloudPanel adapter, SSL, backup framework | M07 (linkage), M09, M10 |
| M07 | Registrar adapters, DNS zones, domain eligibility | M08, M09, M10 |
| M08 | Database/storage/email services | M09, M10, M11 |
| M09 | Model gateway, runs, builder projects, deployments pipeline | M10, M11 |
| M10 | Sandbox, IDE, test runner, mobile builds | M11, M12 |
| M11 | Workflows, marketplace, agency/reseller | M12 |

## 4. Parallel lanes (only if D-02 approves ≥2 teams)
- **Lane P (platform):** M01 → M02 → M03 → M04 (strictly sequential).
- **Lane I (infrastructure):** M05 → M06 → M07 → M08 starts after M04 gate.
- **Lane A (AI):** M09 gateway/session slices (S37–S38) may start after M02 using mocked hosting; full M09 acceptance after M06. M10 after M09 + M08.
- M11 and M12 follow all lanes. Calendar duration under parallel lanes is **not estimated** here; it depends on D-02.

## 5. Gates between milestones
Each milestone ends with a **Gate Review** (template `docs/reports/gate-review-template.md`): all acceptance rows PASS or explicitly BLOCKED with owner; no open critical/high defects; migration + rollback notes reviewed; `spec/` in sync; compliance hooks checklist done; owner sign-off recorded. The next milestone's first sprint may not start until Gate Review is signed (except mocked-interface work declared in the dependent prompt's "Mocked interfaces" table).
