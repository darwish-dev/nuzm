# Open defects and known limitations (M12 decision package)

Prepared by the agent 2026-11-18. This table copies defects and limitations **explicitly recorded** in the M01-M08 reports, gate reviews and assumption files, plus the observations of the M12 security pack. It adds no new finding. **Severity is "to be rated by owner" unless a source report states one.** Status of every row is `KNOWN` (recorded, not triaged by the owner). Nothing here is a recommendation to launch.

Statements about critical/high defects found in the sources (these are the implementing agent's statements at the time, not a tracker export and not an independent assessment):

| Source | Statement |
|---|---|
| M01-gate-review.md | "Open critical/high defects: none known." |
| M02-gate-review.md | "Open critical/high defects: none known." |
| M03-gate-review.md | "Open critical/high defects: none known." |
| M04-gate-review.md | "Open critical/high defects: none known." |
| M05-gate-review.md (adapter half) | "Open critical/high defects in the adapter half: none known." |
| M08-gate-review.md | "Open critical/high defects: none known." |
| M06-report.md, M07-report.md, M07-gate-review.md | No statement about open critical/high defects found. |
| M09, M10, M11 | No gate review exists on this branch. |

GA checklist G-37 ("No open critical/high defects, tracker export attached") stays PENDING: no tracker export exists (see the empty section at the end of this file).

## Known defects and limitations

| ID | Defect / limitation (as recorded) | Source | Milestone | Severity | Status | Related |
|---|---|---|---|---|---|---|
| OD-001 | CSP keeps `'unsafe-inline'` for scripts in both consoles; nonce-based CSP planned for M12 | M01-gate-review; M01-report §F | M01 | to be rated by owner | KNOWN | RK-11 |
| OD-002 | OIDC callback failures render the raw problem+json page | M01-gate-review | M01 | to be rated by owner | KNOWN | |
| OD-003 | Both consoles share one OIDC redirect URI in dev | M01-gate-review | M01 | to be rated by owner | KNOWN | BR-002 |
| OD-004 | Some audit writes are after-the-fact (own transaction, still loud on failure): authentication outcomes, platform-chain admin events outside a service transaction, operation-cancel requests, impersonation notices | M01-report §F | M01 | to be rated by owner | KNOWN | |
| OD-005 | Structured-log helper not yet used by the API; header-scan test not written | M01-report §H | M01 | to be rated by owner | KNOWN | BR-007, BR-016 |
| OD-006 | `audit.audit_logs` is not partitioned (deferred) | M01-deferrals DEF-M01-01 | M01 | to be rated by owner | KNOWN | BR-010 |
| OD-007 | Quota evaluation for usage that arrives only through the worker outbox waits for the next read or API ingest (no sweeper) | M02-gate-review | M02 | to be rated by owner | KNOWN | BR-026 |
| OD-008 | Orders are not counted in the month's spend; project caps see approved spend only | M02-gate-review | M02 | to be rated by owner | KNOWN | BR-027 |
| OD-009 | Spend alert-threshold notifications and balance committed-spend fields not implemented | M02-gate-review | M02 | to be rated by owner | KNOWN | BR-026 |
| OD-010 | No keyboard-only or screen-reader pass for M01/M02 screens | M02-gate-review; DEF-M02-07 | M02 | to be rated by owner | KNOWN | BR-016, BR-028 |
| OD-011 | Money response shape (`…Minor` + `currency`) differs from docs/04 `{amount, currency}`; owner decision requested | M02-deferrals (Still OPEN 2) | M02 | to be rated by owner | KNOWN | Appendix A of the register |
| OD-012 | Billing periodic jobs run in the API process and are off by default; a production profile must enable them (ADR-017 PROPOSED) | M03-gate-review | M03 | to be rated by owner | KNOWN | RK-21 |
| OD-013 | Billing notices are in-app only (email is the dev logger) | M03-gate-review | M03 | to be rated by owner | KNOWN | BR-032, RK-28 |
| OD-014 | Revenue by meter group is not producible (no ledger dimension for meter group) | M03-gate-review; M03-report §H spec issue 4 | M03 | to be rated by owner | KNOWN | RK-31 |
| OD-015 | Wallet top-up payments cannot be refunded | M03-gate-review | M03 | to be rated by owner | KNOWN | RK-31 |
| OD-016 | ZATCA credential renewal / key rotation not built | M03-gate-review; `docs/runbooks/zatca-key-rotation.md` | M03 | to be rated by owner | KNOWN | RK-31 |
| OD-017 | Reporting-window gauge covers the loaded page only | M03-gate-review | M03 | to be rated by owner | KNOWN | |
| OD-018 | Credit-note PDF is not gated by clearance; no pay-quote API; no credit-note PDF operation | M03-report §H AC-M03-09 and spec issues 2 | M03 | to be rated by owner | KNOWN | BRX-003 |
| OD-019 | Log redaction beyond the request path not separately scanned for PAN/CVV | M03-report §H AC-M03-04 | M03 | to be rated by owner | KNOWN | |
| OD-020 | No static source scan for deletion paths in dunning | M03-report §H AC-M03-12 | M03 | to be rated by owner | KNOWN | BRX-002 |
| OD-021 | Several ledger recipes not built (deferred revenue and release, PSP settlement/fee, provider bill paid, FX difference, wallet-debit orchestration) | M03-report §H AC-M03-01 | M03 | to be rated by owner | KNOWN | BRX-001 |
| OD-022 | M04 screens have not been run in a browser; ROPA, retention and assessment screens are read-only; cross-organization DSR queue, data-class coverage screen and platform-floor editor not built; consent grant not possible from the customer screen | M04-gate-review | M04 | to be rated by owner | KNOWN | BR-043, BR-051, BR-052, BRX-007 |
| OD-023 | Compliance jobs run in the API process, off by default; cross-organization discovery needs `WORKER_DATABASE_URL` | M04-gate-review; M04-report §A | M04 | to be rated by owner | KNOWN | RK-21 |
| OD-024 | Production has no export store (`422 no_export_sink`) | M04-gate-review | M04 | to be rated by owner | KNOWN | BR-049 |
| OD-025 | Evidence collectors' scope is limited: no vulnerability database, no live TLS probe, dev audit chain empty | M04-gate-review; `docs/runbooks/compliance-evidence.md` | M04 | to be rated by owner | KNOWN | `compliance-evidence-status.md` |
| OD-026 | Evaluator branch coverage not measured; full integration run not repeated after a test-only time-zone fix; `pnpm verify:full` not run as one command for M04 | M04-gate-review | M04 | to be rated by owner | KNOWN | BR-042, BR-045 |
| OD-027 | `audit_checkpoints` has a trigger but no mutation test of its own | M04-report §H AC-M04-08 | M04 | to be rated by owner | KNOWN | BRX-004 |
| OD-028 | Identity verification for requests about someone else is a written attestation by an administrator, not a platform check | M04-report §A | M04 | to be rated by owner | KNOWN | |
| OD-029 | Every vendor interaction is simulator-verified only; Huawei and Contabo mutating capabilities `unknown` until a live run; no capability-promotion step (SI-M05-10) | M05-gate-review | M05 | to be rated by owner | KNOWN | BR-053, BR-054 |
| OD-030 | Contabo has no price, availability, billing or metrics API, so it cannot be offered without owner-supplied data | M05-gate-review | M05 | to be rated by owner | KNOWN | BR-063 |
| OD-031 | VPC networking is environment configuration (`CLOUD_VENDOR_CONFIG`); UI-M05-13 derives operations from resources; routing simulator is a client-side preview | M05-gate-review; M05-report §I | M05 | to be rated by owner | KNOWN | |
| OD-032 | ROPA entries for Alibaba, Huawei and Contabo not created (offers stay hidden until each is registered as a ROPA processor) | M05-gate-review | M05 | to be rated by owner | KNOWN | BRX-010 |
| OD-033 | Provider cost: vendor minor units are NOT DOCUMENTED (2 digits assumed; prices round up); no FX column (SI-M05-8); RC-04 bill source not wired into finrec (owner PR); no resource-backed cost line is tested | `docs/runbooks/provider-cost-capture.md`; M05-report §J | M05 | to be rated by owner | KNOWN | `cost-model-vs-actual.md` |
| OD-034 | Core-half checks partial: spend-approval reject/expiry paths not re-tested; canary scan of API-wide logs and a full DB dump not run | S17-report AC-M05-08, AC-M05-13 | M05 | to be rated by owner | KNOWN | BRX-008, BRX-009 |
| OD-035 | M06 UI is read-only; wizard, settings/delete and all mutation controls not built | M06-report §C | M06 | to be rated by owner | KNOWN | BR-068, BRX-012 |
| OD-036 | M06 follow-ups not done: TR-02 reconciler, decrypted export, scheduled backups (no scheduler), per-site SFTP/credential rotation, hosting plan subscription via M03, node-agent app | M06-report §I | M06 | to be rated by owner | KNOWN | BR-076, BRX-012 |
| OD-037 | M06 retention targets for `hosting.*` datasets not added to M04; spec additions beyond docs/04 await owner approval; `quota_exceeded` is 422 in the registry vs 429 in docs/04 (registry followed) | M06-report §A, §I; M06-m05-interface-assumptions | M06 | to be rated by owner | KNOWN | BR-082 |
| OD-038 | Restore time budget not measured; ACME-style (not RFC 8555) local server used as the certificate test double | M06-report §H AC-M06-06, AC-M06-07 | M06 | to be rated by owner | KNOWN | BR-069 |
| OD-039 | Domain registration 15-minute completion bound is not timed (runs driven synchronously) | M07-report §H AC-M07-03 | M07 | to be rated by owner | KNOWN | BRX-013 |
| OD-040 | No repository-wide log scanner for adapters' own logs; not every §6 domains endpoint has its own cross-org test (renewals/transfers use a shared helper) | M07-report §H AC-M07-07, AC-M07-08 | M07 | to be rated by owner | KNOWN | |
| OD-041 | No scheduler host for `DomainJobs`; per-order PSP payment not built; entitlement-backed records-per-zone not built; authoritative DNS hosting decision open (D-36) | M07-report §I | M07 | to be rated by owner | KNOWN | BRX-014 |
| OD-042 | M07 transfer with a raw auth code answers 503 in production (no vault write side) | M07-m05-interface-assumptions §4 | M07 | to be rated by owner | KNOWN | BR-091 |
| OD-043 | All M08 results come from mocks; Redis mock-only; self-operated family run only against fakes; no DSR export/erase for messages, suppressions, objects; no consent capture for email processing; provider-cost capture not implemented | M08-gate-review; M08-report §H | M08 | to be rated by owner | KNOWN | BR-099, BRX-015, BRX-016 |
| OD-044 | In-place database restore "approval" is step-up + typed name + pre-restore backup, not a second person (PA-21); UI-M08-16/17 blocked (PA-20/PA-19) | M08-gate-review | M08 | to be rated by owner | KNOWN | BR-105 |
| OD-045 | 60 s scheduler target needs `DATA_SCHEDULER_INTERVAL_SECONDS` ≤ 30 | M08-report §H AC-M08-06 | M08 | to be rated by owner | KNOWN | |
| OD-046 | On a definitive provisioning failure the order hold is not released on this base | M08-upstream-interface-assumptions U-08 | M08 | to be rated by owner | KNOWN | BR-111, RK-17 |
| OD-047 | Security pack observation: auth rate limiting is an in-memory limiter keyed by `req.ip`; no `trustProxy` setting found (NOT VERIFIED either way) | M12-security-assessment-pack/README.md | M12 pack | to be rated by owner | KNOWN | RK-10 |
| OD-048 | Security pack observation: backup downloads carry their token in the query string | M12-security-assessment-pack/README.md | M12 pack | to be rated by owner | KNOWN | RK-12 |
| OD-049 | Security pack observation: `apps/api/src/main.ts` is an empty file; no production bootstrap; no Dockerfile, IaC or container image | M12-security-assessment-pack/README.md | M12 pack | to be rated by owner | KNOWN | RK-13 |
| OD-050 | Dependency advisory GHSA-8988-4f7v-96qf (`@opentelemetry/core` < 2.8.0, via `@nuzm/telemetry`): unbounded memory allocation in W3C Baggage propagation | M12-security-assessment-pack/internal-scans.md §2 | M12 pack | moderate (as reported by the audit tool); owner to confirm | KNOWN | RK-14 |

## Tracker export (empty)

No tracker exists outside the repository, and the repository tracker `docs/reports/M12-security-assessment-pack/pen-test-remediation-tracker.md` contains no findings ("(none recorded)"). The section below is reserved for the owner or the security lead to paste the export (open findings by severity, overdue findings, findings awaiting vendor retest, accepted risks with owner and expiry) when a tracker is opened. GA checklist G-37 requires it.

| Field | Value |
|---|---|
| Tracker system / URL | |
| Export date (UTC) | |
| Exported by (role) | |
| Open critical | |
| Open high | |
| Open medium / low | |
| Overdue findings | |
| Awaiting vendor retest | |
| Accepted risks (owner, expiry) | |
| Export attached (file / link) | |
