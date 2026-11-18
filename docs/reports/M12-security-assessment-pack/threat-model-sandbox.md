# Threat model: AI / app-builder sandbox (M10), PROVISIONAL

> INTERNAL self-assessment, 2026-11-18. NOT independent (HG-12-01 / D-28 BLOCKED).
>
> **Provisional: M10 is in flight and its code is not on this branch.** This model is written from the design in `docs/milestones/M10_fullstack_app_builder_mobile.md` §4 (S45-S49), §9 and §11, `docs/02-system-architecture.md` §7, and ADR-015. ADR-015 is `Proposed - OPEN` with an empty decision (D-21 not taken). **Every mitigation below is `DESIGNED, NOT VERIFIED (M10 in flight)`**; none was observed in code, in a test or on a runner. Re-do this model against the real runner when it lands; the sandbox escape suite must be re-run in M12 against a real runner (M12 §11), and the independent security review is HG-10-02.

## 1. Scope and assets

In scope (when built): sandbox runner and node pool, lifecycle API (`/v1/builder/projects/{id}/sandboxes`), terminal WebSocket, egress proxy and package mirror, build/test workers, mobile signing stage, model-gateway access from sandboxes, artifact/export storage, previews (isolated origin).

| Asset | Why it matters |
|---|---|
| Platform secrets, control-plane datastores | Must never be reachable from generated code |
| Other tenants' sandboxes, repos, artifacts | Isolation promise |
| Mobile signing material (vault refs, short-lived key use) | Release impersonation |
| Model gateway budget and provider keys | Cost abuse, key theft |
| Cloud metadata endpoints and provider credentials on runner hosts | Cloud account takeover |
| Generated source and customer prompts (`customer-content`) | Confidentiality and residency |

## 2. Trust boundaries and actors

1. Control plane / agent runner (trusted, never executes generated code) to sandbox (hostile).
2. Sandbox to sandbox (same org and different orgs).
3. Sandbox to network: default deny; allow-list via filtered DNS and proxy.
4. Sandbox to host runner (container/VM boundary, technology undecided, D-21).
5. User browser to sandbox via WebSocket ticket (single-use, 60 s TTL, bound to sandbox and user, design).
6. Signing stage to everything else (separate worker not reachable from project code).

Actors: malicious tenant author; prompt-injected agent (hostile content in repos, packages, web pages the agent reads); compromised dependency/typosquat; neighbour sandbox; stolen WebSocket ticket holder; compromised model output.

## 3. Threats and mitigations

All statuses: `DESIGNED, NOT VERIFIED (M10 in flight)` unless stated.

| ID | STRIDE | Threat | Design mitigation (source: M10 §9/§11) | Status | Residual risk | Proposed test |
|---|---|---|---|---|---|---|
| SB-01 | E | Container/VM escape to the runner host | Per-project/run sandboxes, no shared FS/PID/net namespaces, no host mounts, no runtime socket, non-root, default-deny seccomp, no privileged caps, read-only root FS | DESIGNED, NOT VERIFIED (M10 in flight) | Technology choice open (D-21); kernel-level escapes are not addressed by namespace isolation alone | Escape suite, at least 60 attempts, against a real runner; kernel/runtime patch gating |
| SB-02 | I | Reaching control-plane datastores or other sandboxes | Dedicated node pool, separate network segment, no route to control-plane datastores; RFC1918 and control-plane ranges blocked | DESIGNED, NOT VERIFIED (M10 in flight) | Misrouted segment, DNS rebinding | Lateral-reach cases in the escape suite; independent port scan from inside |
| SB-03 | I | Cloud metadata endpoint credential theft | Metadata endpoints blocked | DESIGNED, NOT VERIFIED (M10 in flight) | IPv6 and alternative metadata addresses | Metadata reach test (IPv4, IPv6, DNS names, redirects) |
| SB-04 | I/E | Platform secret exposure to generated code | Sandboxes run without platform secrets; canary secrets planted in runner env, control-plane network, neighbour sandboxes and well-known paths; any read pages security and fails the suite | DESIGNED, NOT VERIFIED (M10 in flight) | Canary coverage is only as good as placement | Canary framework in CI against a real runner; zero reads required |
| SB-05 | I | Data exfiltration through egress (DNS tunnelling, proxy bypass, IP literals, IPv6, redirects) | Default-deny egress; filtered DNS + proxy; allow-list limited to package mirror, Nuzm Git, model gateway, declared preview origin; exceptions are time-boxed and hash-bound approvals | DESIGNED, NOT VERIFIED (M10 in flight) | Covert channels over allowed hosts (e.g. Git push) | DNS-exfil and proxy-bypass cases; egress log review |
| SB-06 | D | Resource abuse (CPU spin, fork bomb, disk fill, mining) | Quotas proposed: 2 vCPU, 4 GB, 10 GB disk, 512 PIDs, 5 sandboxes per org, idle 30 min, max life 4 h, build 20 min | DESIGNED, NOT VERIFIED (M10 in flight) | Values are proposals pending D-21 | Quota-edge concurrency test (20 parallel creates) |
| SB-07 | T | Supply-chain attack through dependencies | Ecosystem allow-list, mandatory lockfile, install scripts off by default, advisory scan fails build at high, typosquat check, licence check, SBOM per project version | DESIGNED, NOT VERIFIED (M10 in flight) | Malicious packages with no advisory yet; mirror compromise | Typosquat/install-script corpus; mirror integrity check |
| SB-08 | S/E | Prompt injection making the agent run destructive or paid actions | Human approvals bound to the exact action hash, expiring in 24 h, for production deploy, destructive migrations, paid resource creation, egress/dependency outside allow-list, budget increases, signing use | DESIGNED, NOT VERIFIED (M10 in flight) | Social engineering of the approver; hash binding must cover all effective parameters | Stale-hash and duplicate-approval tests; injected-content red team |
| SB-09 | D | Runaway agent cost | Per-run caps: 2,000,000 tokens, 60 min, 200 steps; hard stop at 100 %; debug loop caps (5 consecutive, 15 per run, stop on 3 identical failures) | DESIGNED, NOT VERIFIED (M10 in flight) | Overshoot of one in-flight call | Budget-overshoot test on mock gateway |
| SB-10 | S | WebSocket ticket theft or reuse across orgs | Single-use ticket, 60 s TTL, bound to sandbox and user | DESIGNED, NOT VERIFIED (M10 in flight) | Token in URL logs | Ticket reuse and cross-org tests |
| SB-11 | I | Cross-tenant access to sandbox, repo, artifact or export | Keyed by `org_id` and verified on every access; `/v1/builder/*` org-scoped with RLS; export signed URL TTL up to 15 min | DESIGNED, NOT VERIFIED (M10 in flight) | Pending the real routes in `spec/openapi` | Tenant sweep must include every M10 operation (`tenant-isolation-sweep.md`) |
| SB-12 | E | Signing material misuse or leak | Vault references only; signing in a separate worker unreachable by project code; short-lived material, never logged or copied into artifacts | DESIGNED, NOT VERIFIED (M10 in flight); real signing `BLOCKED (HG-10-01)` | Entire signing stage unbuilt | Review once built; log/artifact scan for key patterns |
| SB-13 | I | Secrets in build/test logs and generated code | Logs scanned and redacted; `POST .../changes` rejects secret patterns and path traversal | DESIGNED, NOT VERIFIED (M10 in flight) | Pattern-based detection misses novel formats | Seeded-secret log scan |
| SB-14 | T | Path traversal or symlink abuse through the changes API / IDE | Safe-diff apply with traversal rejection (unit test planned) | DESIGNED, NOT VERIFIED (M10 in flight) | Archive/export code paths | Symlink and `..` corpus on changes and export |
| SB-15 | I | Residency and PII breach through model calls from the sandbox | `ResidencyPolicyService` before model provider choice, node region, artifact storage, deploy region; prompts and outputs classified `customer-content` | DESIGNED, NOT VERIFIED (M10 in flight); depends on M09 gateway (also in flight) | Provider region facts unverified (HG-09-01) | Residency tests per M10 §9 |
| SB-16 | R | Missing audit trail | Events `run.started`, `sandbox.created/terminated`, `deploy.*`, `export.*`, `signing.credential.*`, `release.owner_approved` | DESIGNED, NOT VERIFIED (M10 in flight) | - | Audit-coverage check |

## 4. Residual risk

Unquantifiable until D-21 and a real runner exist. This is the surface most exposed to hostile code and the one where a single control failure (for example a missed egress path) has platform-wide impact. Required before GA (M12 gate): escape suite 0 successes on a real runner (AC-M10-02), HG-10-02 independent review with no open critical/high (AC-M10-03), sandbox fleet inside load, chaos and pen-test scope.

## 5. Dependencies

D-21 sandbox technology, HG-10-02 security review, HG-05-04 node-pool quota, HG-10-01 signing, D-34 retention, M09 gateway (in flight).
