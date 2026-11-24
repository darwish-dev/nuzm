# DEFECT-9 — the outbound secret scanner misses the secret shapes that real project files contain

Reporter: Session 07 (QA) · Owner: Session 02 / Master (`packages/domain/src/ai/secret-scan.ts`, used by the AI gateway, the builder agent, mobile signing and the build-log redaction) · cc Session 05 (project files are sent to the model) · Severity: **MEDIUM** (a credential in a customer file can be sent to a model provider and written to a build log) · Status: OPEN · Found 2026-11-24 on `integration/ai-engine` `39658725`

## Where
`secret-scan.ts` `PATTERNS`. The generic rule `api_key_assignment` is `\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{16,}`.

## What it misses (13 shapes, all reproduced in `apps/api/src/qa/qa-secret-scan.int.spec.ts`, values assembled at run time, none real)
- `.env` names with a prefix: `STRIPE_SECRET_KEY=…`, `AWS_SECRET_ACCESS_KEY=…`, `SESSION_SECRET=…`, `JWT_SECRET=…`, `ACCESS_TOKEN=…`: `\b` does not match between `_` and `secret`/`token`, and `…_KEY` is not a keyword (only `api_key`).
- JSON config: `{"password": "…"}`, `{"apiKey": "…"}`, `{"client_secret": "…"}`: the closing quote between the key and the colon is not allowed by `\s*[:=]`.
- YAML with the value on the next line.
- Provider key shapes with no assignment: Anthropic `sk-ant-…`, OpenAI `sk-proj-…`, Google `AIza…`, Stripe `sk_live_…`.
These are exactly the formats of the files an AI builder reads and edits (`.env`, `config.json`, `docker-compose.yml`, pasted keys). The caught set today (13 shapes: key blocks, AWS key id, Nuzm key, vault refs, bearer, JWT, GitHub, Slack, simple assignments, DB URLs, sealed fields) is verified by the same file and must keep passing.

## Expected
A project file or a paste that carries one of these must be blocked before it is sent to a provider (gateway) and its line removed from a build log, exactly like the shapes that are caught today.

## Suggested fix
Match the key name as a token that may be PREFIXED and QUOTED: `(?:^|[^A-Za-z0-9])[A-Za-z0-9_.-]*(?:api[_-]?key|secret|passw(?:or)?d|token|private[_-]?key|credentials?)["']?\s*[:=]\s*["']?…` (case-insensitive), plus a value on the next YAML line; add provider prefixes (`sk-ant-`, `sk-proj-`/`sk-` of 40+ chars, `AIza` + 35, `sk_live_`/`rk_live_`, `pk_live_` is public). Keep the false-positive tests (prose, code) in the same file. Entropy checks may be added later; keep findings value-free.

## Tests
`qa-secret-scan.int.spec.ts` → `15 passed | 13 expected fail`: 13 `it.fails('DEFECT-9 …')` (fail today) and the passing controls; turn each into an ordinary `it` when fixed.
