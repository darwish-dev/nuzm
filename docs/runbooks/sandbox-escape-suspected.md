# Runbook — suspected sandbox escape (M12 S57)

Status: DESIGNED NOT VERIFIED (status vocabulary: NOT VERIFIED, design-level only). The M10 sandbox runner (`builder.sandboxes`, escape-attempt suite, canary secrets) is **not on this branch**: no sandbox runtime, endpoint or alert exists here to execute against. Everything below is derived from the design in `docs/milestones/M10_fullstack_app_builder_mobile.md` (§9, §11) and must be re-validated when M10 merges. Sandbox technology D-21 is OPEN and the independent sandbox security review HG-10-02 is PENDING; the local container runner, if used, is non-isolated and is never isolation evidence.

## Purpose
Contain and investigate a suspected breakout from, or lateral movement out of, a customer-code sandbox into the runner host, the control plane, other tenants' sandboxes or platform secrets.

## Trigger / alert
- A **canary secret** read or used (tokens or files planted in the runner host environment, control-plane network, neighbour sandboxes and well-known credential paths): pages security by design.
- Escape-suite regression in CI (any attempt succeeded), egress-proxy anomalies (IP-literal, IPv6, redirect or DNS-tunnelling attempts), runner host process or network anomalies, an unexpected connection from the sandbox node pool to control-plane datastores, a customer or researcher report.
- A generated app or customer behaving as if it saw another tenant's data.

## Severity guidance
SEV1 by default (suspected tenant-isolation failure or secret exposure). Lower only on the security officer's written decision after evidence shows a false positive.

## Preconditions / access
Security officer role and platform admin in the admin realm with MFA. Cloud admin (`admin:cloud` in the M10 prompt; the repository's current permissions are `admin:provider:*`, to be reconciled). Break-glass on a runner host follows `break-glass-draft.md` (BLOCKED, D-12): two people, time-boxed, session-logged. No one runs customer code on a laptop to "reproduce".

## Steps (design)
1. **Declare SEV1** (`incident-response.md`); open a breach case in parallel as a precaution (`data-breach-workflow.md`) so timers and decisions are recorded.
2. **Contain, reversibly, in this order:**
   1. Stop new sandboxes: switch the M10 builder/sandbox feature flag off (`PUT /v1/admin/feature-flags`; flag key to be confirmed when M10 merges).
   2. Quarantine the affected runner node: node pool cut from the network segment (infrastructure owner), compute resource identified through `GET /v1/admin/resources` (sandbox-node inventory per M10 UI-M10-19). Do not delete it: it is evidence.
   3. Terminate affected sandboxes. The customer endpoint is `DELETE /v1/builder/projects/{id}/sandboxes/{sid}` (org-scoped); **there is no admin force-kill endpoint** in the contract (proposed as PA-08 `POST /v1/admin/sandboxes/{id}/termination` in `docs/04` §2.13, NOT approved; M10 UI-M10-19 hides the action until approved): until then termination is done at the infrastructure layer by the security officer.
3. **Treat platform secrets reachable from the runner host as compromised.** List the vault references that host could read (the design says none should be reachable: if any were, that is itself a finding), rotate them (provider account `credentialRef` via `PATCH /v1/admin/provider-accounts/{id}`, other secrets per `rotating-dev-secrets.md` pattern and the production vault procedure once D-12 is decided), and invalidate outstanding signed URLs by rotating bucket credentials where relevant (`storage-incident.md`). Signing material is held in a separate worker unreachable from project code (design); verify, do not assume.
4. **Preserve evidence** before any rebuild: host and network logs, egress-proxy logs, terminal session audit, the canary alert, the sandbox record and project identifiers (no customer content copied into tickets). Hash and store evidence references.
5. **Scope.** Which organizations had sandboxes on that node or segment; which data classes; whether any cross-tenant read happened. Use audit trails per organization (`GET /v1/admin/audit-logs`, audited cross-organization reads) and the breach case evidence pack (`GET /v1/admin/compliance/breach-cases?id=<case>&pack=true&reason=<why>`).
6. **Root cause and fix** by engineering under security direction; add the technique to the escape suite (`tests/security/sandbox-escape/`, per design) and re-run it against a **real** runner.
7. **Rebuild** the node pool from a clean image; re-enable only after the security officer signs off in the incident record.
8. **Decide notifications** with counsel through `data-breach-workflow.md`.

## Verification
Escape suite (design: at least 60 attempts, 0 successes) re-run on the rebuilt runner; canary alerting tested end to end; no route from the pool to control-plane datastores; rotated secrets verified in use; no unexplained cross-tenant 2xx in the tenant sweep.

## Escalation
Security officer (leads) → L3 engineering lead → owner; compliance officer / DPO and counsel if personal data may be affected; provider contact if the node is a provider instance.

## Communication draft
Not to be sent without the security officer's and communications lead's approval; wording is factual and avoids unverified claims.
EN: "We are investigating a security event affecting the app-building environment. As a precaution, new sandboxes are paused. We will inform affected customers directly if their data is involved. Reference: [incident id]."
AR: "نحقّق في حدث أمني يتعلق ببيئة بناء التطبيقات. وكإجراء احترازي أوقفنا إنشاء بيئات العزل الجديدة مؤقتًا. سنبلغ العملاء المتأثرين مباشرةً إذا تبيّن أن بياناتهم معنية. المرجع: [رقم الحادثة]."

## Records to keep
Incident timeline, evidence hashes and locations, containment actions with UTC times and actors, list of rotated secrets (names only), affected-organization list, breach case id, escape-suite re-run output, security officer sign-off.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). Cannot be exercised until M10 and a real runner exist; a tabletop on the design is possible earlier and must be labelled as such.
