# Node agent — design and threat model (M06 S24, proposal under ADR-020)

Status: PROPOSAL, implemented against a mock agent only (NOT VERIFIED on a real node). Code: `apps/api/src/modules/hosting/internal/agent/`.

## 1. Purpose and trust boundaries
The agent is the only thing on a hosting node that the control plane commands. It exists because CloudPanel documents no remote API (ADR-020). Boundaries:
- **Control plane → node:** the control plane signs a command envelope; it can only ask for allow-listed commands.
- **Node → control plane:** the agent dials out (mTLS). The node exposes no inbound management port (proposal; verified live under HG-06-01).
- **Customer code → node:** customer sites are hostile by assumption. The agent never executes customer-supplied strings.
- Assets: customer files/databases/backups/credentials, node root, the Nuzm CA, vault references, other tenants' data.

## 2. Command envelope (Ed25519)
Fields (canonical JSON, keys sorted, UTF-8): `v`, `nodeId`, `operationId`, `idempotencyToken`, `nonce` (≥128 bit random), `issuedAt`, `expiresAt` (≤ 5 min after issue), `commandId`, `args`. Signature = Ed25519 over `nuzm-agent-cmd-v1\n` + canonical JSON. The agent holds the control plane's public key(s) (key id in the envelope header; rotation = accept two keys during overlap).
The agent rejects, with a distinct audited reason: bad signature, unknown key id, wrong node id, expired / not-yet-valid, replayed nonce, replayed (commandId, idempotencyToken) with different args, non-allow-listed command, args failing the command's JSON schema, oversize envelope. A repeated envelope with the same idempotency token and identical args returns the **recorded result** (no re-execution).

## 3. Allow-list
`inventory`, `site.create`, `site.update`, `site.delete`, `site.suspend`, `site.resume`, `site.find`, `cert.issue`, `cert.install`, `cert.remove`, `domain.bind`, `domain.unbind`, `backup.create`, `backup.restore`, `backup.verify`, `backup.delete`, `usage.report`, `quota.apply`, `db.binding.apply` (reserved; returns unsupported until M08), `site.wipe`, `site.wipe.verify`. Each has a JSON Schema with `additionalProperties:false`, explicit patterns for names (`^s-[a-z0-9]{12,40}$`), domains (RFC-1035 labels, lower-case, ≤253), runtime ids (from the probe), and **no free-form path, shell, flag or command fields**. Anything else = rejected.
Execution: `execve` with an argv array only; never `sh -c`; environment scrubbed; working directory fixed; per-command timeout and stdout/stderr cap; secrets (private keys, DB passwords) are passed by reading a vault reference through a root-only staging file (0600, removed after use), never in argv or logs.

## 4. Identity and channel
Per-node client certificate from the Nuzm internal CA, short lifetime (proposal 24 h), rotated by the agent before expiry; revocation = delete the `node_agents` row (the channel endpoint refuses unknown fingerprints). Enrolment: single-use bootstrap token (hash stored, 15-minute expiry) exchanged for the first certificate; a second use fails. No inbound listener on the node (proposal).

## 5. Agent privileges
Dedicated unprivileged user; narrowly scoped sudo rules for exactly the helper binaries the allow-list needs (no `sudo ALL`); systemd hardening (NoNewPrivileges, ProtectSystem, PrivateTmp, read-only root except site paths); signed self-updates (release signing key separate from the command key; version monotonic; rollback refused).

## 6. Audit
Local append-only hash-chained audit log (every envelope decision incl. rejections), shipped to the control plane (`hosting.node_agents.last_seen_at`, audit stream); the control plane compares counts so gaps are visible.

## 7. Threats (STRIDE-style) and controls
| Threat | Control | Automated test (mock) |
|---|---|---|
| Forged command (no key) | Ed25519 verify | `agent.spec`: unsigned/forged/foreign-key |
| Replay of a captured command | nonce cache + expiry + token ledger | replayed, replay after restart (persisted ledger) |
| Expired / not-yet-valid envelope | strict window, clock skew ≤ 30 s | expired / future |
| Command for another node | `nodeId` bound in the signature | wrong node |
| Argument injection (`; rm -rf`, `../`, `$(…)`, newline, flag smuggling `--force`) | schema patterns, argv-only, no free text | injection corpus |
| Allow-list bypass (unknown command, case tricks) | exact-match map | unknown / case |
| Control plane compromised | allow-list is *in the agent*; no arbitrary exec primitive exists | non-allow-listed rejected |
| Lateral movement node→node via the channel | channel carries envelopes for its own node id only; nodes cannot reach each other (network policy, live check) | wrong node |
| Tenant A reads tenant B (files, DB, proc, tmp) | per-site user/group, 0700 homes, per-site FPM pool, private tmp, `hidepid` proc, per-site DB user | isolation suite (≥ 25 cases) against the mock |
| Resource exhaustion by a site | quotas (disk, inodes, processes, memory), cgroup slices | fork/disk/inode cases |
| Secret leakage in logs/manifests | vault refs, redaction, no argv secrets | key-never-logged test |
| Malicious update | signed, monotonic | not simulated (NOT VERIFIED) |
| CloudPanel privilege escalation (changelog 2.3–2.5) | not relied upon; hardening is ours; patch-level gate in `inventory` | version gate test |

## 8. Residual risk / not verifiable without a node
Real isolation (kernel, FPM, filesystem quota behaviour), real mTLS and CA rotation, signed-update flow, network policy between nodes, clpctl behaviour under hostile input. All BLOCKED on HG-06-01 (+ HG-05-0x); mock results are NOT VERIFIED.
