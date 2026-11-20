# AI Studio — Security Model

Builds on `CLAUDE.md` §4 (tenant safety, AI/untrusted code), M09 §9 and M10 §9. Nothing here weakens those rules.

## 1. Trust zones
| Zone | Runs | May reach | Must never reach |
|---|---|---|---|
| Control plane (`apps/api`, `apps/worker`) | platform code only | Postgres, vault, provider APIs | customer/generated code execution (M10 §9: "control plane never executes generated code") |
| Sandbox node pool (M10) | customer code, dev servers, tests, Claude Code binary, git | allow-listed package registries, the customer's own GitHub repo (per task), the model API for Mode A only via the customer's own sign-in | control-plane datastores, vault, cloud metadata (169.254.169.254, fd00:ec2::254), other sandboxes, host container socket |
| Preview origin | static or proxied preview | nothing internal | console cookies/storage, API tokens (separate registrable domain, strict CSP) |
| Skills quarantine store | fetched third-party files at a pinned SHA | nothing (inert storage) | execution of any kind before approval |

## 2. Controls by threat
| Threat | Control | Where |
|---|---|---|
| Cross-tenant access | org from verified session only; RLS forced on every table; cross-tenant fixture per endpoint | existing (`apps/api/src/modules/tenancy/cross-tenant.int.spec.ts`) |
| Path traversal / symlink escape in file manager | canonical relative path validation; resolve real path inside the sandbox and require it under the project root | existing `appbuilder/internal/sandbox/paths.ts` (`checkPath`) + runtime checks; escape suite `tests/security/sandbox-escape/` |
| Archive bombs / zip-slip on import | per-entry path validation with the same function; size/entry-count caps; no symlink entries | importer (S-A4) |
| Malicious skills (prompt injection, exfiltration, destructive commands, hidden instructions) | static scan → `reject` blocks publication; `review` needs a human; executable skills need two-person approval; pinned commit; no upstream auto-update | `packages/domain/src/ai-studio/skill-scan.ts` (S-A1) + admin workflow (S-A4) |
| Prompt injection via repo content / uploads | untrusted text only inside delimited data blocks; tool allow-list per run kind; schema-validated outputs | M09 S38 §6 |
| Secret leakage | vault refs only; outbound prompt secret scanner; canary secrets in sandbox host and neighbours; no tokens in logs | M09 §9, M10 §9 |
| GitHub credentials | GitHub App with minimum permissions; installation tokens minted per operation, never stored or logged; webhook HMAC (`X-Hub-Signature-256`) verified, deliveries deduped; no force-push; never overwrite uncommitted work | S-A7 |
| Skills repo ↔ customer repo confusion | separate adapters and credentials (`SkillSource` is anonymous/read-only; `GitHostAdapter` is per-installation); a skills source is never granted customer repo access | ADR-064 |
| Claude credentials | Nuzm never sees, stores, proxies or automates them; the customer signs in to the unmodified binary inside their sandbox; sign-out wipes the sandbox home | S-A8, D-38 |
| Resource exhaustion | per-sandbox CPU/RAM/disk/PID quotas, idle 30 min, max 4 h, 5 concurrent/org (M10 proposals) | M10 S45 |
| Unauthorized spend | budgets pre-flight; human approval for paid provisioning and publish | M09 §9, M02 spend approval |

## 3. Audit events to add (with the features)
`builder.skill.imported|approved|rejected|published|disabled`, `builder.project_skill.installed|removed`,
`builder.instructions.updated`, `builder.github.connected|disconnected|pushed|pr_opened`, `builder.sandbox.created|deleted`,
`builder.claude_code.started|stopped` (state only).
