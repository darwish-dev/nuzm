# CONTRACT-04-2: execution approval kind, i18n keys, audit action names, module registration (none)

- **Requester:** Session 04
- **Contract:** `ApprovalKind` (`apps/api/src/modules/ai/internal/run.service.ts`, owned by Session 02/05), `packages/i18n/src/messages.ts` (Master), audit action naming, `app.module.ts` (Master).
- **Proposed (all additive, all needed only when execution is wired, i.e. after D-21; nothing is requested for the offline phase beyond recording it):**
  1. `ApprovalKind` gains `'execution'`; the approval row carries the gateway's `describeForApproval` summary (`profile`, `command`, `cwd`, `network`, `reachesNetwork`, `limits`) and the decision digest from `ApprovalWorkflow`; consumption is single-use and bound to the digest.
  2. i18n keys prefixed `exec.` (ar and en): `exec.approval.title`, `exec.approval.network_warning`, `exec.approval.install_warning`, `exec.status.<state>` for the 12 job states, `exec.refusal.<reason>` for the refusal reasons listed in `policy.ts`, `limits.ts`, `quota.ts` and `orchestrator.ts`. Arabic copy needs the owner's review; Session 04 supplies only the key list (REPORT-04 §"i18n keys") because `messages.ts` is Master-owned.
  3. Audit actions are `ai.execution.<verb>` (18 names in `audit.ts`, `EXEC_AUDIT_ACTIONS`); they satisfy the platform `AuditAction` template type (`<domain>.<resource>.<action>`). No registry change is needed if actions are free-form strings; if there is an action registry, add them.
  4. **Module registration:** none. No `execution.module.ts` exists and nothing is registered in `app.module.ts`. When execution is wired the Master adds one line for the module that provides the orchestrator.
- **Why:** records what the wiring step will need so it is not rediscovered; nothing changes in the offline phase.
- **Additive?** Yes.
- **Tests added:** `audit.spec.ts` (action names and content-free detail), `execution-port.spec.ts` (sink adapter).
- **Sessions affected:** 05 (builder approval kinds), 02 (run service), 01.
- **Master answer:** _(pending)_
