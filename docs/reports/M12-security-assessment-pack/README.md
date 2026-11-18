# M12 Security Assessment Pack (S56)

> **INTERNAL self-assessment. NOT an independent assessment. The independent pen test is HG-12-01 (D-28) and is BLOCKED/PENDING; nothing here substitutes for it.**

Prepared 2026-11-18 by the implementing agent for the owner. Nothing in this pack is a sign-off, a certification or an attestation. No vendor has been selected (D-28 is OPEN); no vendor is named anywhere in this pack.

## Provisional sections

- **M09, M10 and M11 are still being built** at the time of writing. They are not on this branch. Every statement about the AI gateway (M09), the sandbox (M10) and delegated access (M11) comes from the milestone prompts (`docs/milestones/M10_*.md`, `M11_*.md`), not from code. Their threat-model sections are **provisional** and every mitigation in them is marked `DESIGNED, NOT VERIFIED (M10 in flight)` / `(M11 in flight)`.
- The S55 enterprise work (`apps/api/src/modules/enterprise`, migration `1710__identity__sso_scim`) is being written by another session. `threat-model-enterprise-sso-scim.md` therefore lists **requirements the code must meet**, not findings about code. Re-run the review once S55 lands.
- No staging environment exists (D-15, HG-05-xx). Anything that needs a deployed environment (DAST, TLS, load, DR) is `BLOCKED`.

## Contents

| File | Purpose |
|---|---|
| [threat-model-control-plane.md](threat-model-control-plane.md) | API, identity, tenancy/RLS, audit, secrets, admin plane |
| [threat-model-shared-hosting.md](threat-model-shared-hosting.md) | M06 CloudPanel nodes and the node agent (mock-only evidence) |
| [threat-model-sandbox.md](threat-model-sandbox.md) | M10 sandbox runner (design only, provisional) |
| [threat-model-delegation.md](threat-model-delegation.md) | M11 agency delegated access and reseller isolation (design only, provisional) |
| [threat-model-payments-zatca.md](threat-model-payments-zatca.md) | M03 PSP, webhooks, ledger, invoicing, ZATCA (simulated server only) |
| [threat-model-enterprise-sso-scim.md](threat-model-enterprise-sso-scim.md) | S55 SAML/OIDC SSO and SCIM: required mitigations |
| [asvs-l2-matrix.md](asvs-l2-matrix.md) | OWASP ASVS 4.0.3 Level 2 self-assessment, V1..V14 |
| [tenant-isolation-sweep.md](tenant-isolation-sweep.md) | The automated endpoint x cross-tenant-token sweep |
| [internal-scans.md](internal-scans.md) | SAST / dependency / container / secret / IaC / DAST plan and results |
| [pen-test-scope.md](pen-test-scope.md) | Scope for the external vendor (HG-12-01) |
| [pen-test-rules-of-engagement.md](pen-test-rules-of-engagement.md) | DRAFT rules of engagement (counsel to review) |
| [pen-test-remediation-tracker.md](pen-test-remediation-tracker.md) | Severity policy (SLA proposals), empty tracker, retest process |

## How to read statuses

Only the CLAUDE.md §6 vocabulary is used.

| Status | Meaning in this pack |
|---|---|
| `PASS` | The control was located in the code or spec by the author on 2026-11-18 **and** a named automated test or file backs it. The test suites were **not re-run for this pack**; run results live in the milestone reports and `M12-report.md`. Where the author executed a command himself (`pnpm scan:secrets`, `pnpm audit --prod`), the command and output are recorded in `internal-scans.md`. |
| `FAIL` | A requirement is not met (none declared in this pack; findings, if any, go to the tracker). |
| `BLOCKED (HG-xx/D-xx: reason)` | Needs a human decision, external party or environment that does not exist yet. |
| `NOT VERIFIED` | Implemented or plausible, but the author saw no evidence, or evidence exists only against mocks or fixtures. Never treat as acceptable by default. |
| `N/A` | Not applicable, with the reason given (ASVS matrix only). |

`DESIGNED, NOT VERIFIED (M10 in flight)` and `(M11 in flight)` are `NOT VERIFIED` rows whose design comes from a milestone prompt.

## Ground rules used while writing

1. Every file or test reference was checked to exist in this worktree. A reference is evidence that the control exists, not that it is sufficient.
2. Mock or fixture results (hosting agent, PSP, ZATCA simulated server, node isolation suite) are `NOT VERIFIED` against the real thing, per CLAUDE.md §6.
3. No finding has been fabricated. The remediation tracker starts empty. Observations that deserve a test are listed as "proposed tests", not as defects.
4. No secrets, no real credentials, no personal data and no vendor names. Contacts and credentials are placeholders (`<PLACEHOLDER>`).
5. The SLA numbers (7/14/30/90 days) are **proposals** from the M12 prompt, pending owner approval.

## Gate mapping

| Acceptance row | Status | Where |
|---|---|---|
| AC-M12-09 tenant sweep, 0 unexplained cross-tenant 2xx | see `M12-report.md` (filled by the parent) | `tenant-isolation-sweep.md` |
| AC-M12-10 internal assessment, 0 open critical/high from SAST/DAST/dependency/container scans | NOT VERIFIED: SAST tool not selected or run; DAST BLOCKED; dependency scan run (0 high/critical in prod deps, 1 moderate) | `internal-scans.md` |
| AC-M12-11 independent pen test, critical/high fixed and retested | `BLOCKED (HG-12-01 / D-28)` | `pen-test-*.md` |

## Observations the owner should see first

These are not defects declared by this pack; each has a proposed test in the relevant file.

1. `apps/api/src/main.ts` is an empty file at this commit; the API is started through `apps/api/src/dev/dev-stack.ts`. There is no production bootstrap to assess yet.
2. Auth rate limiting uses an in-memory limiter keyed by `req.ip` (`apps/api/src/common/rate-limit.ts`); no `trustProxy` setting was found. Behind the Next.js `/v1` rewrite the API may see one client address for everyone. NOT VERIFIED either way.
3. The CSP in both consoles keeps `'unsafe-inline'` for scripts (`apps/web/next.config.mjs`, `apps/admin/next.config.mjs`); nonce-based CSP is tracked as M12 hardening.
4. Backup downloads carry their token in the query string (`apps/api/src/modules/hosting/backup-downloads.controller.ts`).
5. All ADRs in `docs/adr/` are still `Proposed`; the secrets/vault decision (ADR-016 / D-12) is open, so production secret handling is `BLOCKED`.
6. No Dockerfile, IaC or container image exists in the repository, so container and IaC scans have nothing to scan (`internal-scans.md`).
