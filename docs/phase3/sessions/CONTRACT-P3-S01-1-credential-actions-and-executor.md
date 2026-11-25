# CONTRACT-P3-S01-1 — admin actions for key rotation/revocation, kill switch drill, evidence ingestion; executor script lines

From: P3-S01 · To: Master · Status: REQUEST (nothing below is applied by P3-S01: spec, SDK, package.json and messages are Master-owned).

## 1. What exists already on `feature/p3-s01-providers` (service level, tested)
`ModelProviderService.rotateCredential / revokeCredential / ingestExecutorEvidence` and `KillSwitchDrillService.run` (exported from `apps/api/src/modules/ai/index.ts`, wired in `ai.module.ts`). They are NOT reachable over HTTP yet: adding a route or an `action` value changes the OpenAPI contract, so the controller is unchanged until you apply this request (otherwise `pnpm spec:drift` fails). Tests: `p3-s01-credentials.int.spec.ts` (integration), `kill-switch-drill.spec.ts`, `live-executor.spec.ts` (unit).

## 2. OpenAPI (`POST /v1/admin/ai/model-providers`, the same path): four new `action` values
Add to the `action` enum (spec line of `clear_credential`) and to the description; no new path, no new error code.
| action | permission | body | success | notes |
|---|---|---|---|---|
| `rotate_credential` | `admin:ai:manage` | `id`, `apiKey` (20–400 printable, write-only) | `{provider, rotatedAt, vendorSteps[]}` | tests the new key with a read-only model listing (live gate required) before swapping; 422 `validation_failed` if the provider refuses it (the old key stays); 422 `unsupported_capability` in production or while the live gate is closed |
| `revoke_credential` | `admin:ai:manage` | `id`, `reason` (`compromised`\|`scheduled`\|`offboarding`\|`other`), optional `engageKillSwitch` (default true for `compromised`) | `{provider, killSwitch, vendorSteps[]}` | clears the key, disables the provider, audits `ai.provider.credential_revoked` |
| `kill_switch_drill` | `admin:ai:manage` | `orgId` (uuid; the organization whose pre-flight is used) | `DrillReport {ok, restored, boundMs, steps[{id, ok, ms, detail}]}` | sends nothing to any provider; audits `ai.killswitch.drill`; refuses to start while the switch is already engaged |
| `ingest_executor_evidence` | `admin:ai:approve` | `id`, `envelope` (the `nuzm.p3-provider-evidence` JSON) | the provider DTO | 422 `validation_failed` with a fixed reason; writes `ai.model_capability_evidence` rows only from a LIVE-VERIFIED track-B record |
All four need the recent-MFA step-up like the other actions. Audit actions added: `ai.provider.credential_rotated`, `ai.provider.credential_rotation_failed`, `ai.provider.credential_revoked`, `ai.killswitch.drill`.

Controller patch (inside `act()` of `apps/api/src/modules/ai/admin-ai-providers.controller.ts`; it needs `KillSwitchDrillService` injected in the constructor):
```ts
case 'rotate_credential': need('admin:ai:manage'); return this.providers.rotateCredential(who.userId, id, b.apiKey);
case 'revoke_credential': need('admin:ai:manage'); return this.providers.revokeCredential(who.userId, id, b);
case 'kill_switch_drill': need('admin:ai:manage'); return this.drill.run(who.userId, String(b.orgId ?? ''));
case 'ingest_executor_evidence': need('admin:ai:approve'); return this.providers.ingestExecutorEvidence(who.userId, id, b.envelope);
```
Also extend the `default:` validation message. P3-S01 will do the controller edit and the admin UI (`AiProvidersPanel`: rotate, revoke, drill, ingest) the moment the spec and SDK carry the actions; send me the word.

## 3. `apps/api/package.json` script lines
```
"qualify:p3": "tsx src/modules/ai/internal/live-executor-cli.ts",
"qualify:d": "tsx src/modules/ai/internal/qualify-d-error-mapping.ts",
"qualify:e": "tsx src/modules/ai/internal/qualify-e-agent-loop.ts"
```
(`qualify:d` and `qualify:e` are optional single-track wrappers; the executor runs them with `--tracks D,E`. P3-S01 will add the two wrapper files if you want those scripts: say so.) `qualify:a|b|c|suite` already exist.

## 4. Nothing else
No migration (the existing `ai.model_capability_evidence` table is used; the migration block 2300–2309 stays unused), no ownership-manifest change, no `messages.ts` change until the UI step, no new dependency (the OpenAI and Gemini adapters use the platform `fetch`, no vendor SDK), `app.module.ts` untouched.
