# Runbook — recovering a hosting site (M06 S26)

Status: written against the MOCK node. Steps marked **[LIVE]** have never run on a real node (HG-06-01 PENDING).

**Symptoms:** site `failed` after creation, a restore stuck in `restoring`, a backup `corrupt`, a creation operation `needs_reconcile`.

1. **Find the operation** — admin → Hosting → Sites → the site; operations of kind `hosting.*` carry their steps (`platform.operation_steps`) and error.
2. **`needs_reconcile`** (the answer of the node was lost): never retry by hand. The worker run (`HostingJobs.runDue`, role `nuzm_worker`) looks the effect up by the site name derived from the token (`findByToken`) and adopts it; only a proven absence allows another create. If the node is unreachable the operation stays parked: fix the node/agent first (node-onboarding runbook), then let the reconciler run.
3. **Creation `failed`**: the reservation was released and the site is `failed` with a reason code; the customer can create a new site with a NEW quote and the same name (a failed site does not hold its name: migration 0833).
4. **Restore stuck in `restoring`** (agent lost during restore): the operation is `needs_reconcile`; verify the site on the node (`site.find`, files) **before** anything else. A pre-restore safety backup (`kind = pre_restore`, retention 30 days) exists for every restore: restore THAT backup to undo a bad restore.
5. **Corrupt backup**: marked `corrupt` by the checksum/authentication check; it is never restored. Use an older backup. Do not edit the row: the checksum is the evidence.
6. **Escalate** when a site is `restoring` > 30 min with no operation progress, or when the node reports residual state that does not match the database (TR-02 reconciliation: not built, see M06 report).
Rollback: none needed for reads; any manual change on a node must be followed by an inventory run.
