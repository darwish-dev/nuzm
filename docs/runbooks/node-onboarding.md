# Runbook — onboarding a hosting node (M06 S24)

Status: written against the MOCK agent. Steps marked **[LIVE]** have never been run on a real node (HG-06-01 PENDING) and need a human with a node.

Preconditions: HG-06-01 licence/edition decision recorded (see ADR-020: the CloudPanel licence terms require the licensor's consent to host the software for third parties: legal review first); a running compute instance in the PLATFORM org from M05 (HG-05-0x); ADR-020 accepted or the node is `maintenance` only.

1. **Register** — admin console → Hosting → Nodes → Add (or `POST /v1/admin/hosting/nodes {name, computeInstanceId}` with `Idempotency-Key`, `hosting_admin`, MFA step-up). The node starts in `maintenance`; the enrolment token is shown once (15 min).
2. **[LIVE] Install** CloudPanel on the instance (supported OS/arch: see the findings file row 25) and the Nuzm node agent (unprivileged user, scoped sudo rules, outbound mTLS only).
3. **[LIVE] Enrol** — start the agent with the token; it exchanges it for a short-lived client certificate. A second use of the token fails. Lost token → `POST …/enrolment-tokens` (the old one is invalidated).
4. **Inventory** — `POST …/inventory`: versions, health, runtimes (as reported by the probe), capacity (measured minus the platform reserve, default 10 %, proposal). Check the capacity page (UI-M06-12).
5. **Isolation check [LIVE]** — run the isolation suite against the node (same cases as `isolation.spec.ts`) before activating; record the report under `docs/reports/evidence/M06/`.
6. **Activate** — `PATCH … {status:'active'}` (needs an enrolled agent, healthy fresh inventory, reported runtimes).
7. **Day 2**: certificate rotation (agent rotates before expiry; admin sees `certRotatedAt`), revoke (`revokeAgent`: node → maintenance, new pending agent), command log review (UI-M06-15). Overcommit above 1.0 only through the dual-approval change.
Rollback: set the node `draining`, migrate sites (drain-and-migrate runbook), `retired` when empty; production data is never dropped by migration down files.
