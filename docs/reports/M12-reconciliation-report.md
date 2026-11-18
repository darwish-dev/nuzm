# M12 reconciliation report

Status: **fixtures only. LIVE rows BLOCKED.** Written 2026-11-18. Tolerance: D-31 PRD proposal (0 minor units RC-01/02/05/06, ≤ 0.5 % RC-03/04) — not decided by finance.

| Class | Detects (fixture evidence) | Where | Live |
|---|---|---|---|
| RC-01 payments vs PSP | missing settlement, amount mismatch, unsettled refund, unknown line | `finrec/finrec.int.spec.ts` | BLOCKED (HG-03-02) |
| RC-02 ledger vs invoices | invoice without ledger, wrong VAT/receivable, ledger without document | same | n/a (internal) |
| RC-03 usage vs invoice lines | unbilled usage, missing line, over/under billing, line without usage, tolerance | same | n/a (internal) |
| RC-04 provider cost vs bills | no accrual, wrong accrual, unattributed cost, negative margin, bill source fixture | same; compute bill source not registered in the app (gap) | BLOCKED (HG-05-xx, HG-07-01) |
| RC-05 e-invoices vs documents | unsubmitted, rejected, dead letter, not cleared in window | `finrec/internal/rc05.spec.ts` (scripted DB client) | BLOCKED (HG-03-03) |
| RC-06 wallet vs ledger | drifted/missing projection, top-up without ledger | `finrec/finrec.int.spec.ts` | n/a (internal) |
| TR-01 compute vs provider inventory | unknown state > 1 h, missing at provider, orphaned billable resource | `ops/ops.int.spec.ts` (+ M05 reconciler tests) | BLOCKED (HG-05-xx) |
| TR-02 hosting vs node report | site without allocation, oversold node, missing on node, unknown to platform | `ops/ops.int.spec.ts` | BLOCKED (HG-06-01) |
| TR-03 domains vs registrar | missing, expiry mismatch, unknown to platform | `ops/ops.int.spec.ts` | BLOCKED (HG-07-01) |
| TR-04 data/email vs provider | missing, state mismatch, unknown (tables with `provider_ref`) | detector implemented, covered by the clean/DB-only runs; **no discrepancy injection test for TR-04** | BLOCKED (HG-08-01) |

Gaps: TR-04 injection test missing; RC-05 is tested with a scripted client; billing-close checklist run not executable (no period-lock endpoint). AC-M12-12 is therefore **PASS (fixtures) with these listed gaps**; AC-M12-13 **BLOCKED**.
