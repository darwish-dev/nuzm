# ADR-064: AI Studio additions — GitHub App, Skills, project instructions, Claude Code in sandbox

- Status: **Accepted by the owner in the session of 2026-11-20** for points 1–3 (D-37, D-39, D-40); point 4 (Claude Code) accepted
  **as an isolated proof of concept only** — commercial/production use of customer Claude subscriptions stays gated by D-38. The
  agent recorded the decision; the owner made it.
- Related decisions: D-37 (scope), D-38 (Claude Code legal), D-39 (GitHub App), D-40 (third-party Skills) in `docs/07`
- Evidence: `docs/ai-studio/` (audit 2026-11-20)

## Context
The AI Builder (M09–M12) is built but has no link to customers' existing repositories, no reusable agent knowledge (Skills),
and no per-project instruction file. Customers also ask to use Claude Code. Anthropic's documentation (read 2026-11-20,
`docs/ai-studio/INTEGRATION_RISKS.md` §1) forbids third parties from offering Claude.ai login or routing requests through a
user's subscription credentials, and forbids reselling or intermediating Claude usage; an end user may sign in to the
unmodified Claude Code binary with their own subscription.

## Decision (proposed)
1. **GitHub** through a GitHub App owned by Nuzm, behind a new `GitHostAdapter`; minimum permissions (contents, metadata, pull
   requests, webhooks); installation tokens minted per operation and never stored; webhook signatures verified and deliveries
   deduped; no force-push; uncommitted sandbox work is never overwritten. Tables `builder.github_connections`,
   `builder.github_repos`, `builder.github_events` (append-only).
2. **Skills** as a platform registry (`builder.skills`, `builder.skill_versions` append-only, `builder.skill_reviews` append-only,
   `builder.project_skills`). Third-party skills enter through `SkillSource` (anonymous, read-only, pinned commit, quarantine),
   are statically scanned, and need human approval — two different approvers for skills that ship executable files. No upstream
   auto-update. A skills source never receives customer-repository credentials.
3. **Project instructions**: `builder.project_instructions` + `builder.instruction_versions`; `CLAUDE.md` composed from layers
   (platform < framework < template < project < customer) with stricter-wins for security rules, reported conflicts, and
   customer-owned blocks preserved on regeneration.
4. **Claude Code**: only as a sandbox capability — the unmodified binary is installed in the sandbox image; the customer starts it
   in their own terminal and signs in themselves; Nuzm stores no Claude credentials, sends no prompts on the customer's behalf,
   bills nothing for Claude usage, and shows only observed process/sandbox state. Feature flag `ai.claude_code_sandbox`, off in
   production until D-38 records counsel's opinion. Managed coding (Mode B) keeps using API keys through the existing gateway.

## Alternatives considered
- OAuth App or personal access tokens for GitHub — broader, longer-lived credentials; rejected.
- Copying Skills into templates only — no versioning, no security review; rejected.
- "Sign in with Claude" or a subscription bridge — not permitted by Anthropic's terms; rejected.

## Consequences
New public contracts (OpenAPI paths, tables, audit events) need the S-A2 spec change after acceptance; the pure libraries in
`packages/domain/src/ai-studio` are contract-free and already usable.

## Consistency check (agent, 2026-11-20)
- D-37/D-39/D-40 do not conflict with each other or with D-01 (Nuzm's own repository stays local-only; customers' GitHub repos
  are a product feature reached through `GitHostAdapter`).
- D-39 cannot be exercised live until the owner registers the GitHub App and stores its private key and webhook secret as vault
  references (external credentials, HG-AS-01). Until then the integration runs against a fake adapter and every live row is
  BLOCKED, not PASS.
- D-40's two-approver rule for executable skills needs at least two staff accounts with the skills-approval permission.
- D-38: the prototype runs only in a sandbox the customer opens; it never sees, stores or relays Claude credentials and never
  sends prompts on the customer's behalf. Feature flag `ai.claude_code_sandbox` defaults to off, and the API refuses to enable it
  in production while D-38 is open.

## Owner / date
Owner / 2026-11-20 (session decision, recorded by the agent)
