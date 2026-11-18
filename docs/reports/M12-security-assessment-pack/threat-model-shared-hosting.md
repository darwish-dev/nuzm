# Threat model: shared hosting (M06, CloudPanel nodes and node agent)

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED). **Every result here is against a mock**: no real node, CloudPanel, CA or kernel was exercised (HG-06-01 pending, ADR-020 `Proposed`). Mock passes are `NOT VERIFIED` against reality (CLAUDE.md §6). Companion document: [`docs/runbooks/node-agent-threat-model.md`](../../runbooks/node-agent-threat-model.md), whose control list this file cross-checks rather than copies.

## 1. Scope and assets

In scope: `apps/api/src/modules/hosting` (sites, nodes, agents, backups, abuse, quotas, domains/SSL), the node-agent protocol (`hosting/internal/agent/*`), the CloudPanel adapter (`hosting/internal/cloudpanel-adapter.ts`), migrations `packages/db/migrations/hosting/0800..0833`.

| Asset | Notes |
|---|---|
| Customer site files, databases, backups, TLS private keys | Hostile-neighbour target |
| Node root and the agent identity (client certificate, command public key) | Node takeover = all tenants on the node |
| Command signing key held by the control plane | Forged commands |
| Backup archives and download tokens | Data exfiltration |
| Capacity and quota state | Noisy-neighbour and billing integrity |

## 2. Trust boundaries and actors

- Control plane to node: signed command envelope over an agent-initiated channel (design: mTLS, no inbound management port; **unverified**).
- Customer code to node: customer sites are hostile by assumption (arbitrary PHP/Node on a shared host).
- Tenant A to tenant B on one node: filesystem, `/proc`, sockets, DB users, cron, logs, TLS keys.
- Org user to hosting API: `hosting:*` permissions, feature flag `hosting.enabled` default off (`hosting/internal/hosting-flag.guard.ts`).
- Actors: malicious tenant site, compromised tenant account, network attacker between control plane and node, compromised control plane, compromised CloudPanel, abusive tenant (spam/phishing/mining), rogue staff.

## 3. Threats and mitigations

| ID | STRIDE | Threat | Existing mitigation (verified to exist) | Status | Residual risk | Proposed test |
|---|---|---|---|---|---|---|
| SH-01 | S/T | Forged or modified command to a node | Ed25519 envelope over a domain-separated canonical body; unknown key id, tamper, wrong node, expired, future-dated, ttl > 5 min, oversize all rejected (`agent/envelope.ts`; `agent/agent.spec.ts:44-130`) | NOT VERIFIED (mock agent) | Key custody (vault, D-12), rotation overlap and real transport are unproven | Replay the 14 envelope cases against a real agent build |
| SH-02 | R/T | Replay of a captured command | Nonce ledger persisted across restart; idempotency-token ledger refuses reuse with different args (`agent.spec.ts:114,120,236`) | NOT VERIFIED (mock) | Ledger durability on a real disk | Crash/restart replay on a real node |
| SH-03 | E | Command injection / argument smuggling into `clpctl` or shell | Closed allow-list, JSON schemas with patterns, no free-form path/flag/shell members, `execve` argv only (`agent/commands.ts`, `agent.spec.ts:135-220,278`) | NOT VERIFIED (mock; real `clpctl` behaviour under hostile input unseen) | CloudPanel CLI quirks and changelog privilege-escalation issues are not relied upon but not tested | Injection corpus through the real CLI on a throwaway node |
| SH-04 | I/E | Tenant A reads or writes tenant B (files, symlinks, `/proc`, FPM socket, cron, logs, TLS key, DB) | Per-site user/group, 0700 homes, private tmp, `hidepid`, per-site FPM pool, `open_basedir`, per-site DB user; 30-case suite (`hosting/internal/mock/isolation.spec.ts`, cases 01-30) | NOT VERIFIED (mock) | The suite tests a model of the node; real kernel, FPM and filesystem behaviour is unmeasured. M06 reports 30/30 denied on the mock only | Port the 30 cases to a real node (HG-06-01); add container/user-namespace escape cases |
| SH-05 | D | Resource exhaustion by one site (fork bomb, disk, inode, memory) | Quotas and cgroup slices modelled; cases 26-28; quota events and re-arm (`migrations/hosting/0820,0831`; `hosting-site-ops.int.spec.ts`) | NOT VERIFIED (mock) | Real cgroup enforcement and the noisy-neighbour latency effect | Soak on a real node with a hostile tenant |
| SH-06 | I | Backup theft or cross-tenant restore | Archives encrypted per site (case 30); download link needs same-org session AND a valid unexpired token (`hosting/backup-downloads.controller.ts`, `backups.service.ts`); `content-disposition: attachment`, `octet-stream`, nosniff | NOT VERIFIED | Token travels in the query string (ASVS 8.3.1 deviation); production backup sink is `none` (422 `no_backup_sink`, D-07) so the real path is untested | Token leakage via referrer/log review; header-based alternative |
| SH-07 | I | Secret leakage (DB passwords, TLS keys) in argv, logs or manifests | Vault references, staging file mode 0600, redaction (design); "key never logged" test (mock) | NOT VERIFIED | Secret staging file handling on a real host | Log/argv scan on a real run |
| SH-08 | T/E | Malicious agent update or compromised release key | Signed, monotonic updates (design) | NOT VERIFIED (not simulated) | Entire update channel unbuilt/unproven | Dedicated review once built |
| SH-09 | E | Lateral movement node to node or node to control plane | Channel carries envelopes for its own node id only; agent dials out; network policy between nodes (design) | BLOCKED (HG-06-01: needs a real network) | Unknown until live | Network reach test from a compromised node |
| SH-10 | S | Rogue node enrolment | Single-use bootstrap token (hash stored in `hosting.node_enrolment_tokens`, configurable expiry, proposal 15 min), second use and expired use fail (`hosting/internal/nodes.service.ts`; `hosting-nodes.int.spec.ts:135`) | NOT VERIFIED | CA issuance and 24 h certificate rotation unbuilt | Enrolment race test with a real CA |
| SH-11 | I | Cross-org access to hosting objects through the API | Org RLS on hosting tables; org-scoped controllers; routes covered by `tenancy/cross-tenant.int.spec.ts` fixtures (`backupId`, `caseId`) | PASS (by test existence) | Same caveats as `threat-model-control-plane.md` CP-01 | Tenant sweep |
| SH-12 | T/R | Duplicate sites or users after a lost reply from CloudPanel | Reconcile-before-retry; 500 injected lost-reply runs adopt the existing site (M06-report AC-M06-05; `hosting-sites.int.spec.ts`) | NOT VERIFIED live (PASS on mock) | Real CloudPanel timeout semantics | Fault injection against a real node |
| SH-13 | D/I | Abusive tenant (spam, phishing, mining) | Abuse cases, suspension and wipe flow (`hosting/internal/abuse.service.ts`, `migrations/hosting/0830`, `docs/runbooks/abuse-handling.md`) | NOT VERIFIED | Detection signals absent; manual reporting only | Abuse-flow tabletop (AC-M12-18) |
| SH-14 | E | Vulnerable CloudPanel version (documented 2.3-2.5 escalation issues) | Patch-level gate in `inventory` (design; version gate test on mock) | NOT VERIFIED | Gate threshold depends on the real version list | Verify against the version actually deployed |
| SH-15 | S | Tenant runs untrusted PHP that phones home to attack the control plane | Control plane never executes tenant code; agent has no inbound port (design) | NOT VERIFIED | Egress filtering from nodes undefined | Egress policy review at HG-06-01 |

## 4. Residual risk

The shared-hosting model is the highest inherent risk in the platform (arbitrary code from many tenants on one kernel) and the least verified: **0 results against real infrastructure**. Treat SH-01..SH-10 and SH-14 as open until a real node run exists and the external pen test covers it.

## 5. Dependencies to close

HG-06-01 (a real CloudPanel node), HG-05-0x (compute), D-07 (backup sink), ADR-020 acceptance, D-12 (vault), HG-12-01 (independent test).
