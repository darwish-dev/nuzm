# Runbook: the real runtime node (P3-S02)

Status: **DRAFT written before any node exists. Not exercised on a real node (R4 `NOT VERIFIED`).** It complements `RUNBOOK-EXECUTION.md` (control-plane switches) and `docs/runbooks/sandbox-escape-suspected.md`. Alert rules: `infra/runtime/alerts/runtime-alerts.yaml` (their annotations link to the anchors below; a test keeps them in sync). Commands name the real tools; every command marked (V) is verified when the runbook is first exercised on the node.

Principles: **stop first, investigate second**; a node that ran hostile code, failed to clean up, or behaved unexpectedly is **rebuilt from the image, never repaired or reused**; evidence (audit file, agent logs, `runsc` logs, disk) is preserved before a rebuild.

## Kill switch and emergency stop
Three levels, from narrowest to widest. All are reversible only by a human.
1. **One organization** (control plane): `ExecutionKillSwitch.engageOrg(orgId)`; new submissions are refused, queued jobs stop at claim time, approvals are revoked.
2. **All execution** (control plane): flag `ai.agent.exec_tools` off, or `engageGlobal()`; the gate closes.
3. **One node, immediately** (node): the agent's `emergencyStop` operation (control plane: `RemoteWorkspaceRuntime.emergencyStop()` with an admin-scoped token; node console fallback below). It (a) writes `<stateDir>/DISABLED`, after which the agent refuses `createWorkspace` and `start` and reports `health` as `node_disabled` with 0 free slots; (b) hard-kills every run and destroys its sandbox; (c) destroys every workspace and half-created directory; (d) kills stray `runsc` containers. It reports `{killed, destroyed, failed}`; `failed > 0` means leftovers: treat the node as compromised.
   Node console fallback if the agent does not answer (V): `touch /var/lib/nuzm/state/DISABLED && systemctl stop nuzm-runtime-agent && runsc --root /run/nuzm/runsc list` then for each `nz-*` id `runsc --root /run/nuzm/runsc kill --all <id> SIGKILL && runsc --root /run/nuzm/runsc delete --force <id>`; then `ip netns list`, `ip link show | grep vh-`.
   **Releasing**: an operator deletes `DISABLED` after the incident review and restarts the agent. Nothing releases it automatically. If the cause was a suspected escape, do not release: rebuild.
After any level: confirm with the audit trail (`ai.execution.*` in the platform, `/var/log/nuzm/agent-audit.jsonl` on the node: `emergency_stop`, `workspace_destroyed`) and `listWorkspaces()` empty.

## Cleanup failed or leaked runs
Signals: `NuzmRuntimeCleanupFailed`, `NuzmRuntimeLeakedRuns`, `NuzmRuntimeNodeQuarantined`. The agent keeps a run whose cleanup failed as *leaked* (health `leaked_runs`, 0 free slots) and the control plane quarantines the node.
1. Do **not** destroy by hand yet. Preserve: copy `/var/log/nuzm/agent-audit.jsonl`, `journalctl -u nuzm-runtime-agent`, `runsc` logs, `ip netns list`, `mount | grep nuzm`, `ps -e` into the incident folder.
2. Engage the node's emergency stop (above). If `failed` stays > 0, the node is compromised or damaged: go to step 4.
3. If the stop is clean and the cause is understood and benign (e.g. a full disk): `reap()` once; if `leaked` clears and the inventory script matches the attested one, the reviewer may re-admit by restarting the control-plane service.
4. Otherwise **rebuild the node** from the image and re-qualify (`#re-qualification`). Record the incident (docs/runbooks/sandbox-escape-suspected.md).

## Stuck runs
Signals: `NuzmRuntimeStuckRun`, `NuzmRuntimeUnobservableRuns`. The longest profile wall limit is 300 s; the control plane kills at the limit, the agent's backstop kills at limit + grace (default 5 s), and a run whose statistics cannot be read five times in a row is killed. A run older than 20 minutes means all three failed.
1. Emergency-stop the node. Treat a run that survives a `SIGKILL --all` of its sandbox as an **escape or a runtime bug**: preserve everything, rebuild, tell the reviewer.
2. Read the audit trail for the run: `run_started`, `run_killed` (`why`), `run_limit_kill`.

## Quota breach
Signal: `NuzmRuntimeQuotaBreaches` (kills for `limit_*`, `output_flood`). Expected: a tenant's runaway build or a deliberate probe. Check which organization from the control plane audit (`ai.execution.*`, the run id is not in the metric by design). Do **not** raise a limit to make it go away. Repeated breaches by one organization: engage its kill switch and review. Breaches by many organizations at once: suspect the node (a limit it can no longer enforce): run the inventory script and compare with the attestation.

## Authentication refusals
Signals: `NuzmRuntimeAuthRefusals`, `NuzmRuntimeClientCertRefused`. Reasons are in the agent audit (`request_refused` with a reason code) and the metric label. `token_replayed` or `token_signature_invalid` in volume: a leaked token or key, or a probe of the management interface: rotate the control-plane signing key (add the new public key to `trustedControlKeys`, switch the signer's vault reference, remove the old key) and check the firewall allows the agent port from the control-plane CIDR only. `token_expired`/`token_not_yet_valid`: clock drift (NTP on both sides). A pinned-fingerprint refusal means a certificate that the CA issued is being used by something that is not the control plane: revoke it, rotate the client certificate, find the holder.

## Spec refused on the node
Signal: `NuzmRuntimeSpecRefusedOnNode`. The control plane validates every spec before sending; a refusal on the node means they disagree or a spec was forged. The violation codes are in the control-plane error (`spec_refused:<codes>`). `limit_over_node_ceiling_*` or `egress_not_on_node_allowlist` are configuration drift between `agent.json` and the control plane's policy: align them. Anything else (privileged, root user, environment, mounts) is a control-plane bug or a compromise of the control plane's gateway: treat as a security incident.

## Egress probing
Signal: `NuzmEgressProxyRefusalsSpike`. A sandbox is asking for hosts off the allow-list, non-public addresses (metadata, RFC1918) or ports other than 443. The proxy refused them; the firewall would have too. Identify the run (the proxy logs host and outcome only; correlate by time with agent `run_started`), engage the organization's kill switch, keep the audit. If any request **succeeded** to a host off the allow-list, the proxy or firewall is wrong: emergency-stop, rebuild, tell the reviewer.

## Agent errors
`NuzmRuntimeAgentErrors`: an unexpected exception inside the agent (the response is a content-free `internal`). Read `journalctl -u nuzm-runtime-agent`; a repeating error with a specific operation is a bug: open an issue with the audit lines (never file content).

## Capacity
`NuzmRuntimeSlotsExhausted`, `NuzmEgressProxyTunnelsSaturated`: busy, not broken. Check queue depth in the control plane; add a node (a new node needs its own qualification and attestation) rather than raising `maxSlots` beyond what the node's CPU and memory can hold (each slot may use up to 4 CPUs and the memory ceiling).

## Re-qualification
Triggers: attestation under 7 days from expiry, any change to the kernel, runtime, rootfs digest, firewall, agent or its configuration, any incident, any new escape-suite version. Procedure: `docs/parallel/RUNTIME-QUALIFICATION.md` §0.2 (S3 to S15) on a **rebuilt** node; `qualification.cli.ts negative` (S14) after signing; the evidence index (`qualification.cli.ts evidence`) must be complete before the reviewer signs. An expired or revoked attestation drops the node at its next use; nothing else needs to be done to stop it.
