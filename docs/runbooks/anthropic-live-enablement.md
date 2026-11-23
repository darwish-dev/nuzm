# Runbook — enabling Claude for live calls (non-production only)

**Do not run any step until the owner has approved D1–D6 of `docs/ai-intelligence/S-AG4-PREP.md` §8.** Production stays closed (D-12): the key cannot be stored and the adapter is not registered in a production process. Executable tools stay disabled (`ai.agent.exec_tools` is a name only, D-21).

## Preconditions (each recorded, with who and when)
1. HG-09-01 evidence package complete; attestation reference exists (agreement, flags `retainsPrompts`, `trainsOnData`, region, sub-processors).
2. D-18 decision recorded; for customer content: counsel memo (HG-04-01), per-class transfer assessment approved and unexpired, organization policy allowing the target country, ROPA entry for `claude`.
3. A dedicated non-production vendor key with a **vendor-side spend cap**; its owner and rotation date.
4. Rate card agreed (credits per million tokens for `claude-opus-5-5`).

## Steps (platform admins; two different people for 6)
1. Admin console → AI providers → **Save Claude key** (`save_claude_key`). The key is typed once, sealed, never shown again. Check: the provider row shows only `vault://dev/ai-claude`; `enabled` is false.
2. **Configure** the provider: region (from the contract), rate card, display name. This disables the provider.
3. **Attest** with the reference and the flags from the contract (`attest`). Do not enter a flag the contract does not state: use `unknown`.
4. Set `AI_LIVE_PROVIDERS=claude` in the named non-production environment and restart the API (gate G9). Without this every call and the connection test are refused.
5. **Connection test** (model listing: no prompt, no customer data, nothing billed). Expect `ok`. Anything else: stop and read the audit event `ai.provider.connection_tested`.
6. Admin A: **request enable**; admin B (a different person): **enable** (two-person rule).
7. Residency: confirm an organization's policy and assessment allow the region for the data class you will use; test with a **test organization and test content only**. Fund its credits with a small wallet.
8. Only after the live probe is approved and run (D9): record its result per capability with the admin action `record_capability_evidence` (`admin:ai:approve`, reference to the stored probe report). Tool calling then counts for that model only while the latest row is VERIFIED for the adapter's current contract. Then set the flags `knowledge.agentic_generation` and `ai.agent.read_tools` for the test organization. (The `probe_tool_use` action exists but answers 422 until D9 is approved and its wrapper is built.)

## Verification after enabling
- A chat call from the test organization returns text; `ai.model_usage` has one row with the provider-reported tokens and the region; the wallet fell by the rate-card amount; no `held` reservation remains.
- `GET /v1/ai/models` for another organization whose policy denies the region does **not** list Claude.
- Search the audit log and provider list for the key: it must not appear.

## Stop / rollback (any time, takes effect on the next call)
- Fastest: unset `AI_LIVE_PROVIDERS` (or remove `claude`) and restart: every call is refused before the key is read.
- Admin console: **Disable** the provider; or the platform kill switch (`ai.killswitch`).
- Revoke: **Clear credential** (deletes the sealed key, disables the provider) and revoke the key at the vendor.
- Rotation: save the new key (this disables the provider), then request and approve enabling again.
- Incident: `docs/runbooks/ai-provider-outage.md`, `docs/runbooks/ai-budget-incident.md`.
