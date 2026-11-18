# Blocked register (M12 deliverable; AC-M12-17, GA checklist G-36)

Prepared 2026-11-18 by the implementing agent on branch `claude/m12-hardening-4cc95e`. **The agent has dispositioned nothing.** Every row below is `PENDING owner`; the disposition and target-date columns are for the owner to fill. This register compiles what the milestone reports, gate reviews, deferral records, interface-assumption files and `docs/07-open-decisions-and-blockers.md` already say; no row is invented and no status was changed.

> **AC-M12-17 requires 0 undispositioned rows. Every row in this register is currently UNDISPOSITIONED** (disposition = `PENDING owner` on all of them), so AC-M12-17 and GA checklist G-36 are not met.

## How to read this register

- Source paths are under `docs/reports/` unless they start with `docs/` or `spec/`. "§H" etc. are section letters of the milestone report (CLAUDE.md §10). "gate review" = the milestone's `Mxx-gate-review.md`.
- Status word is exactly `BLOCKED`, `NOT VERIFIED` or `DEFERRED` (CLAUDE.md §6), taken from the source. Where a source row says "PASS on mock / NOT VERIFIED live" the row records the `NOT VERIFIED` half; the PASS half is not reproduced here and does not close the row.
- Owner = role named in `docs/07` (Section B "Owner" column) or the milestone prompt. Where `docs/07` names no role for a decision, `Owner` is used.
- Disposition values the owner may choose (the agent proposes none): accept as non-critical for GA, close with evidence, defer with approved change-log entry, or block GA. Nothing here is a recommendation.
- Rows whose source status word is outside the CLAUDE.md §6 vocabulary (`PARTIAL`, `NOT DONE`, `NOT RUN`, `NOT BUILT`) are not counted in the totals; they are listed in Appendix B so the owner can classify them. They are also UNDISPOSITIONED.
- `PASS (mock)` / `PASS on fixtures` rows are not in this register: they are engineering results, not open items. They never convert a BLOCKED row (CLAUDE.md §6).
- Milestone status at the time of writing: M01 and M02 signed with deferrals; M03, M04, M05 (adapter half), M08 gate reviews are PREPARED, NOT SIGNED ("hold for owner"); M07 gate review is a DRAFT, NOT SIGNED; M06 has a report but no gate review file; M09, M10, M11 are in flight on other branches.

## Count summary (rows in Sections M01–M08 and M12; Appendix B excluded)

| Milestone | BLOCKED | NOT VERIFIED | DEFERRED | Total |
|---|---|---|---|---|
| M01 | 5 | 4 | 8 | 17 |
| M02 | 2 | 2 | 7 | 11 |
| M03 | 8 | 5 | 0 | 13 |
| M04 | 7 | 4 | 0 | 11 |
| M05 (adapter half) | 9 | 3 | 0 | 12 |
| M06 | 6 | 12 | 0 | 18 |
| M07 | 4 | 9 | 0 | 13 |
| M08 | 8 | 10 | 0 | 18 |
| M09 | placeholder | placeholder | placeholder | 0 |
| M10 | placeholder | placeholder | placeholder | 0 |
| M11 | placeholder | placeholder | placeholder | 0 |
| M12 (known today) | 8 | 3 | 0 | 11 |
| **Total** | **57** | **52** | **15** | **124** |

Rows by disposition: **0 dispositioned, 124 UNDISPOSITIONED.** Appendix B adds 17 further source rows with non-vocabulary status words, also undispositioned and not counted above.


## M01 — Bootstrap, IAM, tenancy (signed with deferrals 2026-11-16)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-001 | M01-gate-review (BLOCKED list); M01-report §G | BLOCKED | Git remote and CI access; CI is defined but has never run (bootstrap criterion B8) | HG-01-01; D-01 decided "local only" 2026-11-15 | Owner | PENDING owner | |
| BR-002 | M01-gate-review (BLOCKED list); M01-report §G | BLOCKED | Real identity provider: only a dev test IdP exists; a client and redirect URI per console are needed | HG-01-02, D-04 (OPEN) | Owner/DevOps | PENDING owner | |
| BR-003 | M01-gate-review (BLOCKED list); M01-report §G | BLOCKED | Secrets/KMS: dev stand-ins for the seal key, audit hash-chain keys and TOTP secrets | D-12 (OPEN; ADR-016 Proposed) | Owner | PENDING owner | |
| BR-004 | M01-gate-review (BLOCKED list); M01-report §G (shows `OPEN`) | BLOCKED | Observability backend: OpenTelemetry instruments emit, no collector verified | D-13 (OPEN) | Owner | PENDING owner | |
| BR-005 | M01-gate-review (BLOCKED list); M01-report §G (shows `OPEN`) | BLOCKED | Mail provider: invitations and notifications are logged in dev and refused in production | D-08 (OPEN; M08) | Owner | PENDING owner | |
| BR-006 | M01-report §H "OIDC login + sessions + MFA + recovery + step-up + API keys" | NOT VERIFIED | The same flows against a real IdP (PASS on the dev IdP only) | HG-01-02, D-04 | Owner/DevOps | PENDING owner | |
| BR-007 | M01-report §H "Observability" | NOT VERIFIED | Observability backend; structured-log helper not yet used by the API | D-13 | Owner | PENDING owner | |
| BR-008 | M01-gate-review (migration note); M01-report §H "Runbooks + demo script" | NOT VERIFIED | Snapshot-restore and break-glass runbooks are written but never exercised | Needs D-12 for break-glass; restore drill is M12 (DR) | Owner | PENDING owner | |
| BR-009 | M01-gate-review (compliance hooks checklist) | NOT VERIFIED | `data_region` placeholder `sa-pending` and the allow-all `ResidencyPolicy` stub as built in M01 (M04 report states the real residency service is live; M04 is unsigned) | M04 (HG-04-01 for legal values) | Owner / compliance owner | PENDING owner | |
| BR-010 | M01-deferrals DEF-M01-01 | DEFERRED | Monthly partitioning of `audit.audit_logs` (M01 §7) | Approved change-log entry 2026-11-16; picked up in M12 before GA or earlier if volume warrants | Owner | PENDING owner | |
| BR-011 | M01-deferrals DEF-M01-02 | DEFERRED | UI-M01-28 admin all-organization operations monitor | Approved 2026-11-16; no docs/04 endpoint in M01 list; M12 (`/v1/admin/operations/health`) | Owner | PENDING owner | |
| BR-012 | M01-deferrals DEF-M01-03 | DEFERRED | UI-M01-29 role/permission matrix viewer | Approved 2026-11-16; picked up in M02 admin UI work (not shown as done in M02 reports) | Owner | PENDING owner | |
| BR-013 | M01-deferrals DEF-M01-04 | DEFERRED | UI-M01-04 standalone `/auth/mfa-challenge` page; UI-M01-19 operations detail drawer | Approved 2026-11-16; picked up in M05 (first real operations) | Owner | PENDING owner | |
| BR-014 | M01-deferrals DEF-M01-05 | DEFERRED | PA-17 audit integrity badge/endpoint; PA-18 notification preferences endpoint/screen | Approved 2026-11-16; waits for PA-17/PA-18 approval | Owner | PENDING owner | |
| BR-015 | M01-deferrals DEF-M01-06 | DEFERRED | E2E for invitation accept via mail link and for impersonation start + banner | Approved 2026-11-16; needs a mail catcher (M08) / next E2E extension | Owner | PENDING owner | |
| BR-016 | M01-deferrals DEF-M01-07 | DEFERRED | Keyboard-only walkthrough; header-scan test; load smoke (200 rps `/v1/me`); DB-failover-during-relay test | Approved 2026-11-16; picked up in M12 | Owner | PENDING owner | |
| BR-017 | M01-deferrals DEF-M01-08 | DEFERRED | PII classification annotations for `identity.users` fields (M01 §9.4) | Approved 2026-11-16; picked up in M04 (S13). M04 report states classification coverage 1035/1035; the deferral row was not re-confirmed closed in a gate review | Owner | PENDING owner | |

## M02 — Ledger, metering, entitlements (signed with deferrals 2026-11-17)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-018 | M02-report §H AC-M02-14; M02-gate-review | BLOCKED | Approved price book v1 active; pricing and margin policy (placeholder book is refused in production) | HG-02-01; D-23, D-25 OPEN | Finance | PENDING owner | |
| BR-019 | M02-report §H AC-M02-16; M02-gate-review | BLOCKED | Provider-cost import / RC-04 against real provider bills (capture and accrual exist, no import endpoint) | M05 + HG-05-01..03 (no real bills) | Owner/Finance | PENDING owner | |
| BR-020 | M02-report §H AC-M02-15 | NOT VERIFIED | Tax and residency on quotes verified against the real engines | M03/M04 (both unsigned); HG-03-03/HG-03-04, HG-04-01 | Owner | PENDING owner | |
| BR-021 | M02-report §G | NOT VERIFIED | mTLS between metering producers and the ingress is documented only | D-12 | Owner | PENDING owner | |
| BR-022 | M02-deferrals DEF-M02-01 (AC-M02-06) | DEFERRED | AC-M02-06 at the 10,000-random-operation scale (wallet projection = Σ2100) | Approved 2026-11-17; M03 (RC-06 library check) | Owner | PENDING owner | |
| BR-023 | M02-deferrals DEF-M02-02 (AC-M02-11) | DEFERRED | Ingest/aggregation SLO on 1M events; 10M-event aggregation fixture | Approved 2026-11-17; D-30 targets are proposals; M05 first producer / M12 hardening | Owner | PENDING owner | |
| BR-024 | M02-deferrals DEF-M02-03 | DEFERRED | UI-M02-14 platform-wide raw usage events; UI-M02-16 provider-cost import | Approved 2026-11-17; no docs/04 endpoint; waits for endpoint approval | Owner | PENDING owner | |
| BR-025 | M02-deferrals DEF-M02-04 | DEFERRED | UI-M02-11 price-book diff view; UI-M02-12 plan editor; UI-M02-15 adjustment request list and manual-lines form | Approved 2026-11-17; M03 admin UI / endpoint approval | Owner | PENDING owner | |
| BR-026 | M02-deferrals DEF-M02-05 | DEFERRED | Quota sweeper for outbox-only usage; spend alert-threshold notifications; committed-spend/credits fields on `GET /v1/billing/balance` | Approved 2026-11-17; M03 (balance), M05 (producers, sweeper) | Owner | PENDING owner | |
| BR-027 | M02-deferrals DEF-M02-06 | DEFERRED | `credit` authorizations (wallet holds); orders counted in the month's spend; project attribution of usage | Approved 2026-11-17; M03/M05 | Owner | PENDING owner | |
| BR-028 | M02-deferrals DEF-M02-07 | DEFERRED | Keyboard-only and screen-reader walkthroughs; header-scan; load smoke | Approved 2026-11-17; M12 | Owner | PENDING owner | |

## M03 — Payments, invoicing, tax, ZATCA (gate review PREPARED, NOT SIGNED; "hold for owner")

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-029 | M03-report §H AC-M03-07 | NOT VERIFIED | Arabic and English invoice PDFs visually approved (samples in `docs/reports/samples/`; automated checks pass) | Owner reviewer approval pending | Owner | PENDING owner | |
| BR-030 | M03-report §H AC-M03-08; §G table | NOT VERIFIED | UBL XML, hash chain, QR, signature, CSR attributes vs ZATCA: only the synthetic profile and local structural validator; ZATCA spec not pinned, no official goldens | HG-03-03 | Finance/Tax | PENDING owner | |
| BR-031 | M03-report §G table | NOT VERIFIED | 3-D Secure, recurring charges and refunds on a real PSP (mock behaviour only) | D-10, HG-03-02 | Finance | PENDING owner | |
| BR-032 | M03-report §G table | NOT VERIFIED | Email delivery of billing notices (dev logger only) | D-08 / M08 | Owner | PENDING owner | |
| BR-033 | M03-report §G table | NOT VERIFIED | RC-01 against a real PSP settlement report; RC-05 on simulated data | D-10; live data | Finance | PENDING owner | |
| BR-034 | M03-report §G table | BLOCKED | Hosted card field / redirect (sandbox test-card picker only) | D-10 | Finance | PENDING owner | |
| BR-035 | M03-report §H AC-M03-20 | BLOCKED | Live PSP sandbox end-to-end (add card, charge, refund, webhook, settlement); no real PSP adapter exists, only `psp-mock` | D-10, HG-03-02 | Finance | PENDING owner | |
| BR-036 | M03-report §H AC-M03-21 | BLOCKED | PSP production approval and first live transaction | HG-03-02 | Finance | PENDING owner | |
| BR-037 | M03-report §H AC-M03-22 | BLOCKED | ZATCA sandbox/simulation compliance checks with owner credentials (only our own simulated server exercised) | HG-03-03 | Finance/Tax | PENDING owner | |
| BR-038 | M03-report §H AC-M03-23 | BLOCKED | ZATCA production CSID, clearance and reporting (refused by the platform) | HG-03-03 (owner action) | Finance/Tax | PENDING owner | |
| BR-039 | M03-report §H AC-M03-24 | BLOCKED | Tax advisor sign-off on invoice templates, credit notes, reseller treatment (14-question list in M03-report §G) | HG-03-04 | Tax advisor | PENDING owner | |
| BR-040 | M03-report §H AC-M03-25 | BLOCKED | Real billing entity (VAT, CR) loaded; issuing is refused outside sandbox | HG-03-01, D-33 | Finance | PENDING owner | |
| BR-041 | M03-report §H AC-M03-26 | BLOCKED | RC-04 against real provider bills | M05; HG-05-01..03 | Finance | PENDING owner | |

## M04 — Saudi compliance and residency (gate review PREPARED, NOT SIGNED; "hold for owner")

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-042 | M04-report §H AC-M04-01; M04-gate-review | NOT VERIFIED | Policy-evaluator branch coverage ≥ 95 % (72/72 matrix passes; no coverage provider) | Coverage tooling decision | Owner | PENDING owner | |
| BR-043 | M04-report §H AC-M04-13; M04-gate-review | NOT VERIFIED | UI-M04-01..16 browser e2e and axe: no screen has been run in a browser | Needs a browser run before sign-off | Owner | PENDING owner | |
| BR-044 | M04-gate-review (compliance hooks checklist) | NOT VERIFIED | Compliance runbooks (`dsr-handling`, `legal-hold`, `retention-archival`, `field-encryption`, `breach-handling`, `compliance-evidence`, `residency-hooks`) not reviewed by the compliance owner (a human); counsel review of Arabic/English wording | HG-04-01 | Legal / compliance owner | PENDING owner | |
| BR-045 | M04-gate-review (verification gap) | NOT VERIFIED | Full integration run not repeated after a test-only time-zone fix; `pnpm verify:full` not run as one command for M04 | Verification gap named by the gate review | Owner | PENDING owner | |
| BR-046 | M04-report §H AC-M04-15 | BLOCKED | Counsel values (PDPL role, lawful bases, transfer rules, DPO, retention) loaded from owner-signed config | HG-04-01 | Legal | PENDING owner | |
| BR-047 | M04-report §H AC-M04-16 | BLOCKED | NCA/CST applicability with a human validator; register built, no row validated | HG-04-02 | Legal/Security | PENDING owner | |
| BR-048 | M04-report §H AC-M04-17 | BLOCKED | Third-party assessment (cannot be produced by the agent) | HG-04-03 | Security | PENDING owner | |
| BR-049 | M04-gate-review (BLOCKED list) | BLOCKED | Production export store (`ExportSink`): production answers 422 `no_export_sink` | D-07 (M08) | Owner | PENDING owner | |
| BR-050 | M04-gate-review (BLOCKED list) | BLOCKED | Legal decisions: residency stance D-14, hosting location D-15, PDPL roles D-16, NCA/CST scope D-17, retention periods D-34 | D-14, D-15, D-16, D-17, D-34 (OPEN, legal) | Legal | PENDING owner | |
| BR-051 | M04-report §H screens line (UI-M04-15) | BLOCKED | UI-M04-15 cross-organization DSR queue (no endpoint) | PA-13 | Owner | PENDING owner | |
| BR-052 | M04-report §H screens line (UI-M04-16) | BLOCKED | UI-M04-16 platform floor editor and simulator (no endpoint) | SI-M04-8 | Owner | PENDING owner | |

## M05 — Provider framework and compute (adapter half S18–S23 only; gate review PREPARED, NOT SIGNED; core half S16/S17 has no gate review file)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-053 | M05-report §H "adapter kit"; M05-gate-review; evidence-index EV-M05-A02..A04 | NOT VERIFIED | Alibaba, Huawei and Contabo adapters pass the conformance kit (15/15) on fixtures/simulators only; signers, DryRun semantics, client-token replay, tag lookup and delete/cancel behaviour are unproven live | HG-05-01/02/03 | Owner | PENDING owner | |
| BR-054 | M05-gate-review (known limitations); M05-report §I SI-M05-10 | NOT VERIFIED | Huawei and Contabo mutating capabilities are `unknown` until a live run; no capability-promotion step exists | HG-05-02/03; SI-M05-10 | Owner | PENDING owner | |
| BR-055 | M05-report §H AC-M05-14; M05-report §J | NOT VERIFIED | UI-M05-01..16 e2e and axe; Playwright specs 08/09, `pnpm test:e2e` and `pnpm verify:full` never run; no screenshots | Ports held by other sessions; owner may accept fixture-backed e2e after a green run on the integrated branch | Owner | PENDING owner | |
| BR-056 | M05-report §H AC-M05-15 | BLOCKED | Alibaba verified-region report from a live account (Saudi region NOT VERIFIED) | HG-05-01 | Owner | PENDING owner | |
| BR-057 | M05-report §H AC-M05-16 | BLOCKED | Alibaba live lifecycle | HG-05-01, HG-05-04 | Owner | PENDING owner | |
| BR-058 | M05-report §H AC-M05-17 | BLOCKED | Huawei verified-region report from a live account (ME-Riyadh NOT VERIFIED) | HG-05-02 | Owner | PENDING owner | |
| BR-059 | M05-report §H AC-M05-18 | BLOCKED | Huawei live lifecycle | HG-05-02, HG-05-04 | Owner | PENDING owner | |
| BR-060 | M05-report §H AC-M05-19 | BLOCKED | Contabo probe and EU location verified | HG-05-03 | Owner | PENDING owner | |
| BR-061 | M05-report §H AC-M05-20 | BLOCKED | RC-04 on real provider bills (fixture logic PASS) | HG-05-01..03 | Finance | PENDING owner | |
| BR-062 | M05-gate-review (BLOCKED list) | BLOCKED | Provider quotas and spend caps | HG-05-04 | Owner | PENDING owner | |
| BR-063 | M05-gate-review (BLOCKED list) | BLOCKED | Price book: offers without a Nuzm price stay hidden; Contabo has no price/availability API so it can never be offered without owner-supplied data | D-23 (OPEN) | Finance | PENDING owner | |
| BR-064 | M05-gate-review (BLOCKED list) | BLOCKED | Control-plane hosting location / in-Kingdom backup target | D-15 (OPEN) | Owner | PENDING owner | |

## M06 — CloudPanel shared hosting (report only; NOT DONE, nothing signed; no gate review file exists)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-065 | M06-report §H AC-M06-04 | NOT VERIFIED | Tenant isolation on a real node (30 escape cases pass on the mock only; real node BLOCKED) | HG-06-01 | Security | PENDING owner | |
| BR-066 | M06-report §H AC-M06-05 | NOT VERIFIED | Lost-reply/idempotent site creation against a real node (mock PASS, 500 runs) | HG-06-01 | Owner | PENDING owner | |
| BR-067 | M06-report §H AC-M06-14 | NOT VERIFIED | Real node agent (14 envelope cases + allow-list pass on a mock agent; no `apps/node-agent` app exists) | HG-06-01 | Owner | PENDING owner | |
| BR-068 | M06-report §H AC-M06-16 | NOT VERIFIED | Hosting UI is partial and read-only; e2e, axe and screenshots NOT RUN | Needs a browser run; mutation screens not built | Owner | PENDING owner | |
| BR-069 | M06-report §H AC-M06-06 | NOT VERIFIED | Restore time budget not measured (backup→restore fixtures identical on mock) | HG-06-01; M12 DR | Owner | PENDING owner | |
| BR-070 | M06-report §G; evidence/M06/cloudpanel-spike-findings.md | NOT VERIFIED | Every `[LIVE]` / "verify live" row of the CloudPanel findings table (existing-domain behaviour, idempotent re-run, vhost edit, renewal, quotas, usage, suspension, hardening, version gate) | HG-06-01 | Owner | PENDING owner | |
| BR-071 | M06-report §G | NOT VERIFIED | mTLS and CA rotation, signed self-update, neighbour-latency isolation, live TLS issuance | HG-06-01, M07 real domain | Security | PENDING owner | |
| BR-072 | M06-m05-interface-assumptions A-01, A-02 | NOT VERIFIED | Integration with real M05: replace local `m05-contracts.ts` copy; implement `ComputeProvisioningPort` over `InstanceService`; textual merge conflicts expected | Owner-directed exception (M05 absent at start); integration not done | Owner | PENDING owner | |
| BR-073 | M06-m05-interface-assumptions A-03 | NOT VERIFIED | Vault write side missing: M05 `VaultClient` is read-only; hosting needs to write per-site secrets | D-12; gap to decide | Owner | PENDING owner | |
| BR-074 | M06-m05-interface-assumptions A-05; M06-report §I | NOT VERIFIED | `DomainOwnershipVerifier` is a mock; real verifier comes from M07 | M07 integration | Owner | PENDING owner | |
| BR-075 | M06-m05-interface-assumptions A-06; M06-report §I | NOT VERIFIED | Database binding returns `422 unsupported_capability` until M08 supplies a provider | M08 integration | Owner | PENDING owner | |
| BR-076 | M06-m05-interface-assumptions A-11; M06-report §I | NOT VERIFIED | TR-02 hosting-site reconciler against the node report not built | Needed for M12 TR-01..04 coverage | Owner | PENDING owner | |
| BR-077 | M06-report §H AC-M06-08 | BLOCKED | Live TLS issuance on a real site | HG-06-01 + a real domain (M07) | Owner | PENDING owner | |
| BR-078 | M06-report §H AC-M06-17 | BLOCKED | ADR-020 (CloudPanel automation path) is Proposed; owner decision and node evidence needed | D-20 | Owner | PENDING owner | |
| BR-079 | M06-report §H AC-M06-18 | BLOCKED | Production backup sink (production sink is `none`; 422 `no_backup_sink`) | D-07 / P-M06-1 | Owner | PENDING owner | |
| BR-080 | M06-report §H AC-M06-19 | BLOCKED | Independent pen test of node agent and isolation | HG-12-01 | Owner | PENDING owner | |
| BR-081 | M06-report §A (licence), §G | BLOCKED | CloudPanel licence/edition decision and provisioned nodes: the licence terms require the licensor's written consent for third-party hosting/resale; a legal question not answered by the agent | HG-06-01 | Owner/Legal | PENDING owner | |
| BR-082 | M06-report §G | BLOCKED | Acceptable-use policy text, abuse thresholds, hosting backup/log retention and export window | HG-04-01 | Legal | PENDING owner | |

## M07 — Domains, DNS, reseller (gate review DRAFT, NOT SIGNED; mock-evidence only)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-083 | M07-report §H AC-M07-01 | NOT VERIFIED | Registrar adapters pass kit 18/18 on mock evidence only; vendor behaviour unverified (R15/R16 skipped for ResellerClub: no documented webhooks/atomic DNS) | HG-07-01 | Owner | PENDING owner | |
| BR-084 | M07-report §H AC-M07-11 | NOT VERIFIED | Domains e2e spec written, NOT RUN; axe not run | Ports owned by other sessions | Owner | PENDING owner | |
| BR-085 | M07-report §H AC-M07-12 | BLOCKED | Live registration | HG-07-01 | Owner | PENDING owner | |
| BR-086 | M07-report §H AC-M07-13 | BLOCKED | `.sa` registration route; Saudi TLDs blocked by policy | HG-07-02, D-19 | Owner/Legal | PENDING owner | |
| BR-087 | M07-report §H AC-M07-14 | BLOCKED | HTTPS on a real site (hosting site is a fake) | HG-07-01 + M06 | Owner | PENDING owner | |
| BR-088 | M07-report §H AC-M07-15 | BLOCKED | Real registrar statement for RC-04 (mock statement only) | HG-07-01, D-31 | Finance | PENDING owner | |
| BR-089 | M07-m05-interface-assumptions §1, §2 | NOT VERIFIED | Registrar contracts are byte-for-byte mirrors of `@nuzm/adapter-contracts` and the registrar kit is a separate package; semantic unification with M05 not done | Owner-directed exception; integration backlog | Owner | PENDING owner | |
| BR-090 | M07-m05-interface-assumptions §3 | NOT VERIFIED | `cloud.provider_capabilities` rows not written for registrars; capability matrix not unified with M05 | Integration backlog | Owner | PENDING owner | |
| BR-091 | M07-m05-interface-assumptions §4 | NOT VERIFIED | Vault `put` for transfer auth codes: production wiring is `UnavailableVault`, so `POST /v1/domains/transfers` with a raw `authCode` answers 503 in production | D-12 | Owner | PENDING owner | |
| BR-092 | M07-m05-interface-assumptions §5 | NOT VERIFIED | Fund reservation uses a ledger reservation while M05 uses `commerce.authorizations` holds; hold semantics not unified | Integration backlog | Finance / Owner | PENDING owner | |
| BR-093 | M07-m05-interface-assumptions §7 | NOT VERIFIED | `HostingSiteReadPort` is an in-memory fake; real implementation belongs to M06 | M06 integration (see AC-M07-14) | Owner | PENDING owner | |
| BR-094 | M07-m05-interface-assumptions §8 | NOT VERIFIED | Domain events not consumed by an M05 resource indexer into `cloud.resources` | Integration backlog | Owner | PENDING owner | |
| BR-095 | M07-m05-interface-assumptions §9 | NOT VERIFIED | M05's compute bill source and M07's registrar statement both register via `BillSourceRegistry`; the M05 finrec owner PR is not done | Integration backlog; RC-04 | Finance | PENDING owner | |

## M08 — Managed data, storage, email (gate review PREPARED, NOT SIGNED; "hold for owner"; milestone NOT DONE)

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-096 | M08-report §H AC-M08-01 | NOT VERIFIED | Conformance passes on dev-reference/fixtures; every `provider-*` adapter is a skeleton with all capabilities `unknown` (no official vendor documentation cited) | D-05..D-09 OPEN; HG-08-01..04 | Owner | PENDING owner | |
| BR-097 | M08-report §H AC-M08-03 | NOT VERIFIED | Restore verification on simulated data only; no real PostgreSQL/MySQL restore | HG-08-01, D-05 | Owner | PENDING owner | |
| BR-098 | M08-report §H AC-M08-16 | NOT VERIFIED | 15 of 17 screens built; E2E written, NOT RUN; axe and screenshots do not exist | Ports in use | Owner | PENDING owner | |
| BR-099 | M08-gate-review (known limitations); M08-report §A | NOT VERIFIED | Redis behaviour is mock-only (Redis not installed); self-operated family run only against a fake compute port and fake node agent | D-06; HG-05-01/02 | Owner | PENDING owner | |
| BR-100 | M08-report §H AC-M08-10 | BLOCKED | Mailbox DNS verification on a real domain; mailbox provider | HG-08-03 (§G; §H cites HG-08-01), D-08/D-09, M07 | Owner | PENDING owner | |
| BR-101 | M08-report §H AC-M08-11 | BLOCKED | Real email send, webhooks, warm-up, abuse policy | HG-08-04 (§G; §H cites HG-08-01), D-08 | Owner | PENDING owner | |
| BR-102 | M08-report §H AC-M08-12 | BLOCKED | Managed DB/Redis on verified Saudi infrastructure | D-05/D-06, HG-05-01/02, HG-08-01 | Owner | PENDING owner | |
| BR-103 | M08-report §H AC-M08-13 | BLOCKED | S3-compatibility suite and per-credential scoping on the real object-storage endpoint | D-07, HG-08-02 (§G; §H cites HG-08-01) | Owner | PENDING owner | |
| BR-104 | M08-report §H AC-M08-14 | BLOCKED | Usage tolerance against a real provider statement (mechanism tested on the mock) | D-31, HG-08-01 | Finance | PENDING owner | |
| BR-105 | M08-report §H screens line; §G | BLOCKED | UI-M08-16 (admin deliverability console) and UI-M08-17 (admin fleet) | PA-20 / PA-19 not approved | Owner | PENDING owner | |
| BR-106 | M08-gate-review (provider-selection ADRs) | BLOCKED | ADR-050..054 are Proposed, none accepted; no service may be enabled in production (admin API refuses without accepted ADR + live probe + evidence + second approver) | D-05, D-06, D-07, D-08, D-09 | Owner | PENDING owner | |
| BR-107 | M08-gate-review (decision 5); M08-report §G | BLOCKED | Counsel items for email content/metadata transfer and backup residency | HG-04-01 | Legal | PENDING owner | |
| BR-108 | M08-upstream-interface-assumptions U-01..U-03 | NOT VERIFIED | Adapter contracts are mirrors of M05's; data/email/storage capability ids and catalog types not added to M05's closed unions/schema | Owner-directed exception; integration backlog (U-12 merge conflicts expected) | Owner | PENDING owner | |
| BR-109 | M08-upstream-interface-assumptions U-04, U-05, U-10 | NOT VERIFIED | `ComputePort` over M05 `InstanceState` (needs `privateIps`), provider accounts/capabilities/regions via M05 registry; region ids resolve through `MockRegionRegistry` fixtures on this base | Integration backlog | Owner | PENDING owner | |
| BR-110 | M08-upstream-interface-assumptions U-06, U-07 | NOT VERIFIED | `DataOperations` is a mirror of M05's operations extension; pricer `residency` field ignored by the quote service on this base | Integration backlog | Owner | PENDING owner | |
| BR-111 | M08-upstream-interface-assumptions U-08 | NOT VERIFIED | On a definitive provisioning failure the order/authorization hold is NOT released (no release table on this base; M05's `release(..., 'operation_failed')` not called) | Integration backlog; money-affecting | Finance / Owner | PENDING owner | |
| BR-112 | M08-upstream-interface-assumptions U-09 | NOT VERIFIED | Databases, buckets and mailboxes not registered in `cloud.resources`; `resource_id` stays NULL; no `resource.upserted` event (TR-01 coverage) | Integration backlog | Owner | PENDING owner | |
| BR-113 | M08-upstream-interface-assumptions U-13, U-15 | NOT VERIFIED | `DatabaseBindingPort` (M06) and `DnsLinkagePort` (M07) have no real implementations; default `NoBindings` / `NoDnsLinkage` | M06/M07 integration | Owner | PENDING owner | |

## M09 — AI core and website builder

Milestone in flight on another branch (`claude/m09-ai-builder-a33bbe`); rows to be added when its gate review exists. No rows have been invented here. Counted rows: 0.

## M10 — Full-stack app builder and mobile

Milestone in flight on another branch (`claude/m10a-app-builder-7cee56`); rows to be added when its gate review exists. No rows have been invented here. Counted rows: 0. (Related gates from `docs/07`, not rows: HG-10-01, HG-10-02, HG-10-03, D-21, D-22.)

## M11 — Automation, marketplace, programs

Milestone in flight on another branch (`claude/m11-automation-2a587e`); rows to be added when its gate review exists. No rows have been invented here. Counted rows: 0. (Related gates from `docs/07`, not rows: HG-11-01, HG-11-02, D-26.)

## M12 — Enterprise, hardening, launch (rows known on 2026-11-18)

Sources: `docs/milestones/M12_enterprise_hardening_launch.md` §13 (rows marked `BLOCKED-until-evidence`) and `docs/reports/M12-security-assessment-pack/README.md`. The parent session's `M12-report.md` and the load/chaos/DR/reconciliation reports will add or update rows; none of them existed when this register was written.

| ID | Source | Status | What | Reason / gate | Owner | Disposition | Target date |
|---|---|---|---|---|---|---|---|
| BR-114 | M12 prompt §13 AC-M12-02 | BLOCKED | SSO verified against at least one real enterprise IdP tenant per protocol (local test IdPs give NOT VERIFIED results only) | HG-12-02; D-27 | Owner | PENDING owner | |
| BR-115 | M12 prompt §13 AC-M12-11; security pack README gate mapping | BLOCKED | Independent penetration test completed, critical/high fixed and retested; the internal pack is not independent | HG-12-01, D-28 | Owner | PENDING owner | |
| BR-116 | M12 prompt §13 AC-M12-13 | BLOCKED | RC-01..RC-06 on live sandbox/provider data, labelled LIVE-VERIFIED | HG-05-01..03, HG-07-01, HG-03-02 | Finance | PENDING owner | |
| BR-117 | M12 prompt §13 AC-M12-14 | BLOCKED | ZATCA production clearance/reporting in the production environment | HG-03-03 | Finance/Tax | PENDING owner | |
| BR-118 | M12 prompt §13 AC-M12-19 | BLOCKED | Counsel, regulatory and certification rows of the compliance evidence report tracked as owner-supplied | HG-04-01, HG-04-02, HG-04-03 | Legal/Security | PENDING owner | |
| BR-119 | M12 prompt §13 AC-M12-20 | BLOCKED | Support training delivered and runbooks accepted by support/on-call | HG-12-03, D-29 | Owner | PENDING owner | |
| BR-120 | M12 prompt §13 AC-M12-21 | BLOCKED | Go/no-go decision recorded by the owner | HG-12-03 | Owner | PENDING owner | |
| BR-121 | security pack README gate mapping AC-M12-10; internal-scans §2, §4 | NOT VERIFIED | Internal assessment: SAST tool not selected or run; container/IaC have nothing to scan; dependency scan run (0 high/critical in production deps, 1 moderate `@opentelemetry/core` advisory); no dev-dependency audit or SBOM | Tooling decision; findings go to the remediation tracker | Security | PENDING owner | |
| BR-122 | security pack README (provisional sections); internal-scans §2 | BLOCKED | DAST, TLS checks, load, chaos and DR at declared scale need a deployed staging environment; none exists | D-15; HG-05-xx (no staging). The pack README says these are BLOCKED; the parent's M12 reports may update this row | Owner | PENDING owner | |
| BR-123 | security pack README; threat-model-sandbox.md | NOT VERIFIED | Sandbox (M10) threat model is design-level only: `DESIGNED, NOT VERIFIED (M10 in flight)`; sandbox isolation security review pending | HG-10-02, D-21 | Security | PENDING owner | |
| BR-124 | security pack README; threat-model-delegation.md | NOT VERIFIED | Delegated access / reseller isolation (M11) threat model is design-level only: `DESIGNED, NOT VERIFIED (M11 in flight)` | M11 gate review | Security | PENDING owner | |

## Appendix A — Open decisions referenced by the rows (not counted)

`docs/07` Section A decisions with status OPEN on 2026-11-18 (the agent may not assume any answer): D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10, D-11, D-12, D-13, D-14, D-15, D-16, D-17, D-18, D-19, D-20, D-21, D-22, D-23, D-24, D-25, D-26, D-27, D-28, D-29, D-31, D-33, D-34, D-35, D-36. DECIDED: D-01 (local only), D-02 (one team, sequential), D-30 (SLO 99.9 %, RPO 15 min, RTO 4 h), D-32 (Arabic default). Also open per the M01/M02 deferral files: additive contract changes beyond docs/04; PA-12, PA-17, PA-18, `POST /v1/admin/organizations` semantics; impersonation approval model; one OIDC client per console; money response shape; `plan` quote semantics; endpoints for provider-cost import and platform-wide usage events; ADR-017 (billing/compliance jobs in the API process, PROPOSED); SI-M04-1..9; SI-M05-7..10; PA-15, PA-19, PA-20, PA-21. These are decisions, tracked in the GA checklist (G-35), not rows of this register.

## Appendix B — Source rows with a status word outside the CLAUDE.md §6 vocabulary (not counted; UNDISPOSITIONED)

The owner should classify each one (for example as DEFERRED with a change-log entry, or accept). The agent has not.

| ID | Source | Source status word | What |
|---|---|---|---|
| BRX-001 | M03-report §H AC-M03-01 | PARTIAL | Ledger recipes not built: deferred-revenue invoice and its release, PSP settlement/fee (5200), provider bill paid, FX difference, wallet-debit orchestration |
| BRX-002 | M03-report §H AC-M03-12 | PARTIAL | No static source scan proving no automatic data-deletion path in dunning |
| BRX-003 | M03-report §H AC-M03-14 | PARTIAL | UI-M03-11 reviews the quote only (no pay-quote API); UI-M03-19 verified with an empty queue only |
| BRX-004 | M04-report §H AC-M04-08 | PARTIAL | `audit_checkpoints` has a trigger but no mutation test of its own; `access_reviews` is M12 |
| BRX-005 | M04-report §H AC-M04-10 | PARTIAL | Claims-guard CI half passes; e2e half NOT RUN |
| BRX-006 | M04-report §H AC-M04-12 | PARTIAL | RLS cross-tenant coverage over compliance org tables is partial |
| BRX-007 | M04-report §H screens line | NOT BUILT | UI-M04-08 data-class coverage screen (no endpoint); UI-M04-07/-11/-12 are read-only lists; consent granting from the customer screen needs SI-M04-6 |
| BRX-008 | S17-report AC-M05-08 | PARTIAL | Spend-approval reject and expiry paths not re-tested in M05; e2e in S23 not run |
| BRX-009 | S16-report/S17-report AC-M05-13 | PARTIAL | Canary-secret check: API-wide log scan and full DB-dump scan not run (core half) |
| BRX-010 | M05-gate-review (compliance hooks) | NOT CREATED | ROPA entries for Alibaba/Huawei/Contabo not created; offers stay hidden until each provider is registered as a ROPA processor |
| BRX-011 | M06-report §H AC-M06-09, AC-M06-11 | e2e NOT RUN | Quota/bandwidth and dunning-hook behaviour pass at API/service level; no e2e; M03 hosting subscription not built |
| BRX-012 | M06-report §C, §I | NOT BUILT | UI-M06-02 wizard, UI-M06-10 settings/delete and every mutation control; UI-M06-16 hidden until M11; scheduled backups (no scheduler); decrypted export; per-site SFTP/credential rotation; hosting plan subscription via M03 |
| BRX-013 | M07-report §H AC-M07-09 | NOT RUN | Domains load test (proposal values only) |
| BRX-014 | M07-report §I | NOT BUILT | Scheduler host for `DomainJobs` (M12), per-order PSP payment, entitlement-backed records-per-zone |
| BRX-015 | M08-report §H compliance checklist | NOT DONE | Consent/lawful-basis capture for email processing (M04 hook not wired); DSR export/erase for messages, suppressions, objects |
| BRX-016 | M08-report §I | NOT BUILT | Provider-cost capture to `metering.provider_cost_records` for data/email/storage |
| BRX-017 | M01-report §H (not covered by DEF-M01-xx) | NOT DONE | UI-M01-02 callback is a server redirect; per-org scope for flags (UI-M01-26) and chain-verification result (UI-M01-27, needs PA-17) are partial; RTL screenshot diff not done (screenshots stored, not diffed) |
