# Runbook: execution path (offline draft)

Status: DRAFT. There is no runtime and the gate is closed, so there is nothing to operate yet; this is the procedure the design implies, to be exercised once a runner exists. It complements `docs/runbooks/sandbox-fleet.md` and `docs/runbooks/sandbox-escape-suspected.md`.

## Stop everything (kill switch)
1. Engage the execution kill switch: global (`ExecutionKillSwitch.engageGlobal`) or one organization (`engageOrg`). New submissions are refused (`execution_kill_switch`), queued jobs are stopped at claim time, approvals are revoked. Releasing is deliberate and separate; nothing releases it automatically. The platform AI kill switch stops these calls too.
2. Run the emergency terminator for the scope (`terminate({kind:'org'|'all'|'run'}, ports)`): revoke approvals, drain the queue, SIGTERM then SIGKILL of each process group, destroy the workspace, mark the job `terminated`, audit every step. A failed step is recorded and the plan continues. Read the report: `failed` lists zombies (`still_running`); isolate that node (cordon) and treat it as compromised.
3. Confirm with the audit trail: `ai.execution.terminated` and `ai.execution.kill_switch` records, and that `planCleanup` shows no remaining workspace for the scope.

## A canary appeared in an output
The orchestrator already redacted it, audited `output_redacted`, and engaged the organization's kill switch. Follow `sandbox-escape-suspected.md`: preserve the node, recycle it, review the runner's own log; do not release the switch until the reviewer says so.

## Runtime unhealthy
`RuntimeHealthMonitor`: degraded takes no new runs; unhealthy ends the running work. Do not retry an uncertain run blindly: the job is requeued once after its lease expires, then failed; reconcile with the runner first.

## Cleanup
`planCleanup` lists what to destroy and why (job ended after the grace, terminated, lifetime, idle, orphan, failed). Execute the plan, audit `workspace_destroyed`, and verify on the node that the processes, mounts and files are gone.

## Budgets and abuse
The restrictive default admits nothing (budget 0). Refusals count toward abuse signals; a spike of `refused` or `quota_refused` for one organization is a reason to engage its switch and review.
