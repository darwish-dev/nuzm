# M09 — AI Core & Website Builder

Read CLAUDE.md first. Apply it in full. This prompt never overrides docs/04, docs/05, docs/03 — on conflict stop and report.

| Field | Value |
|---|---|
| Sprints | S37–S41 (5 sprints) |
| Depends on (docs/03) | **H:** M01, M02, M04, M06 · **S:** M03, M05, M07, M08 |
| Produces | Model gateway, AI sessions/runs, builder projects (type `website`), visual editor, previews, `deploy` pipeline (`POST /v1/deployments`), forms/CMS basics |
| Gate | Gate Review signed; evaluation thresholds approved by owner; preview-isolation test report accepted |
| Response format | CLAUDE.md §10 (A–I) |

## 1. Objective
Deliver a multi-model AI gateway and a prompt-to-website product: a non-technical user describes a business, answers requirement questions, gets a multi-page Arabic/English website, edits it visually or by chat, and publishes it to an M06 hosting site (optionally on a custom domain), with hard spend caps, residency-aware model routing, safe previews and human approval for paid/destructive actions. AI output for websites is a **versioned structured site model** rendered by a trusted renderer; arbitrary generated code execution is out of scope until the M10 sandbox.

## 2. Preconditions & mocked interfaces
| Interface | Status | Allowed mock until | Real needed for |
|---|---|---|---|
| M01–M02 (runs need `platform.operations`, metering, credits, quotas) | DONE | — | all |
| M04 residency/consent/retention | DONE | — | model routing, prompt retention |
| M06 hosting sites + `HostingAdapter.deploy`-capable path | DONE (hard dep) | fake hosting adapter in CI | AC-M09-14 live publish (needs real node: HG-05-01/02, HG-06-01) |
| M07 `DnsLinkagePort` | soft | fake | AC-M09-15 |
| M08 email send, storage bucket | soft | fake ports | form notification & asset bucket rows |
| Model providers | no contract | `ModelAdapter` mock (deterministic, record/replay fixtures) | HG-09-01, D-18 |
Mock model output is for plumbing tests only; quality rows (§13) require a real model (BLOCKED otherwise).

## 3. Requirement IDs closed
FR-AIC-01 model gateway · FR-AIC-02 budgets · FR-AIC-03 sessions · FR-AIC-04 requirements agent · FR-AIC-05 generation · FR-AIC-06 visual editor · FR-AIC-07 versioning · FR-AIC-08 publish. Consumes FR-MTR-*, FR-CMP-05.

## 4. Automatable engineering tasks
### Sprint S37 — Model gateway, budgets, credits
1. `ModelAdapter` contract (docs/09 §7): `complete`, `stream`, `embed?`, `tokenCount`, `region`, `dataTerms`, `pricing`; conformance suite; mock adapter; adapters for real providers implemented only per D-18/HG-09-01 from official docs (cited in `docs/adapters/<provider>.md`).
2. Gateway: routing by (capability, context length, cost, latency, **residency**), fallbacks that never silently cross residency or exceed budget; per-request `dataTerms` check (adapter declares retention/training flags *as contractually verified by a human*; unknown ⇒ treated as "may retain/train", blocked for `personal`/`customer-content` unless policy allows).
3. Budgets: `GET/PUT /v1/ai/budgets` at org, project, run levels (tokens and credits), daily org cap; **pre-flight reservation** of max cost (`max_tokens × rate`) before each call, post-call reconciliation; hard stop when remaining < reservation; kill switch (org + global flag). `ai.credit_balances` is a projection of ledger wallet (M02); credits purchasable via `POST /v1/quotes` `kind=ai-credit` (see issue list for missing order path).
4. Metering: `ai.tokens_input`, `ai.tokens_output` per call from provider-reported counts (fallback `tokenCount` flagged `estimated`), `ai.credits_consumed` via rating (price book). Usage idempotent per call id.
5. `GET /v1/ai/models` (filtered by org residency policy and entitlements), `GET /v1/ai/credits`; admin `GET/POST /v1/admin/ai/model-providers` (accounts via vault refs, enable flags, rate cards).
6. Prompt/response logging policy: store structured metadata always; prompt/response bodies only if org enables and retention (D-34), encrypted, `personal`/`customer-content` class; secret scanner on outbound prompts (block + audit on detection).

### Sprint S38 — Sessions, runs, requirements/architecture agents, templates
1. `POST/GET /v1/ai/sessions`, `GET/POST /v1/ai/sessions/{id}/messages`; `POST /v1/ai/runs` with `kind=website|edit|chat` (other kinds → `422 unsupported_kind` until M10), `GET /v1/ai/runs/{id}`, `GET /v1/ai/runs/{id}/events` (SSE with `Last-Event-ID` resume), `POST /v1/ai/runs/{id}/cancellation`, `POST /v1/ai/runs/{id}/approvals`.
2. Run engine on `platform.operations`: states `queued → running → waiting_approval → succeeded|failed|cancelled|budget_exceeded`; checkpoints after each step; resumable; step-level metering; concurrency quota.
3. Requirement-discovery agent: structured Q&A producing `requirements` artifact (JSON schema: business type, audiences, languages, pages, tone, brand colors/logo, contact data, integrations, domain wishes), validated; max question count (proposal 12) and "skip with defaults".
4. Architecture agent: site map, page sections, design tokens, SEO plan → `architecture` artifact; user approves before generation (approval kind `plan`).
5. Template library: ≥8 templates (proposal) covering restaurant, clinic, retail, portfolio, services, education, NGO, landing page — each ar and en, RTL-correct, expressed as site-model fragments; versioned in `packages/domain/builder-templates`.
6. Untrusted-content defenses: all user uploads/URLs/CRM text enter prompts only inside delimited data blocks; no tool can read secrets; tool allow-list per run kind; structured output validated by schema (reject/repair ≤2 times); SSRF-safe fetcher (deny private/link-local/metadata ranges, redirects re-checked, size/time caps); content moderation hook (policy provider decision pending — default deny-list + rate limits).

### Sprint S39 — Website generation and previews
1. Site model (`packages/contracts/site-model`, versioned JSON schema): pages → sections → components (hero, text, image, gallery, features, pricing, testimonials, FAQ, contact form, map embed (allow-listed providers only), footer, nav), styles via tokens, i18n strings per locale, SEO block. Renderer produces static HTML/CSS (+ minimal first-party JS) into `builder.project_files`; no model-authored script is executed or embedded.
2. Generation pipeline (`kind=website`): requirements → architecture → per-page content/layout → copy in ar/en (RTL logical CSS, `dir`, `lang`, hreflang) → asset handling (user uploads to project storage/M08 bucket; stock/AI-generated imagery only if a licensed source is approved — otherwise placeholders; flagged in issue list) → render → validate (HTML validity, link integrity, alt text, contrast checks).
3. `POST /v1/builder/projects` (`type=website`), `GET/PATCH/DELETE /v1/builder/projects/{id}`, `GET …/files`, `GET …/files/content?path=`.
4. **Previews:** `POST/GET /v1/builder/projects/{id}/previews` — static output served from an **isolated preview origin** (separate registrable domain from console/API, decision recorded as ADR; no shared cookies; strict CSP `default-src 'self'`, `sandbox` for embed in builder iframe, `frame-ancestors` limited to the console origin; short-lived signed URLs; no access to API tokens, vault, or internal network; preview workers have no secrets and no egress). Responsive viewport presets (mobile/tablet/desktop) in UI.
5. Build metering `builder.build_minutes` (renderer + validation time).

### Sprint S40 — Visual editor, chat edits, versions
1. Editor operation model: `POST /v1/builder/projects/{id}/changes` accepts an ordered op set (`insertComponent`, `updateProps`, `moveComponent`, `deleteComponent`, `setTokens`, `setText(locale)`, `addPage`, …) with `baseVersion`; server validates against schema, returns **safe diff** (structural diff + rendered text diff + risk flags such as "deletes page", "changes SEO of 3 pages"), applies atomically; conflicts → `409` with rebase info; undo/redo via inverse ops.
2. Chat edits: `POST /v1/ai/runs` `kind=edit` produces a *proposed* change set; applied only after user accept, except low-risk ops when user enables auto-apply (never for deletes, publish, or paid actions).
3. Versions: `GET /v1/builder/projects/{id}/versions`, `POST …/versions/{vid}/restoration` (creates new head version, never rewrites history); autosave versions every accepted change; named snapshots.
4. Single-writer lock with optimistic concurrency (ETag on project head) for v1; collaboration is out of scope.
5. Editor accessibility/keyboard operability; RTL-aware canvas.

### Sprint S41 — SEO, forms/CMS, deployments, acceptance
1. SEO: per-page title/description, Open Graph, canonical, hreflang, `sitemap.xml`, `robots.txt`, JSON-LD (LocalBusiness/Organization/Product where data present), image alt checks; SEO score report.
2. Forms: `GET/POST /v1/builder/projects/{id}/forms`, `GET …/form-submissions`; published site posts to a Nuzm-hosted ingest endpoint under the preview/site origin with honeypot + per-IP rate limit + size limits; submissions stored encrypted (`personal`), notification via M08 email when available; retention policy.
3. CMS basics: `GET/POST /v1/builder/projects/{id}/cms-collections` (typed fields, items, publish state); renderer consumes collections at build time.
4. **Deployments:** `POST /v1/deployments` `{projectId, target: hostingSiteId, environment}` (needs `Idempotency-Key`; requires approval `kind=publish` from a human with `owner|admin|developer` role + cost disclosure if a new hosting plan is implied), `GET /v1/deployments`, `GET …/{id}`, `GET …/{id}/logs`, `POST …/{id}/rollback`. Build → artifact → deploy via `HostingAdapter` (M06) → smoke check (HTTP 200 on all pages, TLS) → switch; failed smoke check auto-rolls back. Custom domain via `POST /v1/hosting/sites/{id}/domains` + M07 linkage.
5. Evaluation harness and rubric (§11/§13); results stored as `ai.artifacts` (type `evaluation_report`) — see issue list.
6. UI, runbooks, report, demo, acceptance.

## 5. Human approvals & external gates
| ID | Gate | Agent does meanwhile | Default |
|---|---|---|---|
| HG-09-01 | Model provider API contracts + enterprise data terms (retention/training) | Mock adapter; plumbing complete; quality rows BLOCKED | PENDING |
| D-18 | Model providers and inference residency | Gateway enforces policy generically; no provider hardcoded | OPEN |
| HG-04-01 | Counsel memo on sending personal/customer content to models, retention of prompts | Default: block `personal`/`customer-content` to non-approved regions/terms | PENDING |
| HG-05-01/02, HG-06-01 | Real hosting node for live publish | Fake hosting adapter; live rows BLOCKED | PENDING |
| D-23 / D-25 | Credit pricing, expiry, refundability | Parameterized rate cards | OPEN |
| D-32 | Brand/design identity, default language | Defaults ar/en neutral theme | OPEN |
| Owner | Approval of evaluation thresholds (§13 proposals) and content-moderation policy | Use proposals; flag in report | PENDING |
| Legal | Imagery/licensing source for generated sites | Placeholders only | PENDING |

## 6. API specifications (docs/04 §2.9, website-relevant subset; no additions)
Common conventions per docs/04 §1. Roles: `owner|admin|developer` write; `viewer` read; approvals require write role; `billing_admin` credits/budgets.
| Endpoint | Key request | Key response | Errors | Behavior |
|---|---|---|---|---|
| POST/GET `/v1/ai/sessions`; GET/POST `/v1/ai/sessions/{id}/messages` | `projectId?`, `title`, message `content`, `attachments[]` | session/message | 422 `content_blocked` | |
| POST `/v1/ai/runs` | `sessionId`, `kind`, `projectId?`, `input`, `budget{maxTokens,maxCredits}` | `202` run `{id,state,operationId}` | 402 `insufficient_credits`, 429, 422 `residency_denied`/`unsupported_kind`, 409 `run_active` | `Idempotency-Key`; budget reservation |
| GET `/v1/ai/runs/{id}` · GET `/v1/ai/runs/{id}/events` | | run summary + usage; SSE events `{seq,type,data}` | 404 | resumable |
| POST `/v1/ai/runs/{id}/cancellation` | | `202` | 409 terminal | |
| POST `/v1/ai/runs/{id}/approvals` | `approvalId`, `decision`, `note` | run resumes | 403 role, 409 expired | approval kinds: `plan`, `apply_changes`, `publish`, `delete`, `spend` |
| GET `/v1/ai/models` · GET `/v1/ai/credits` · GET/PUT `/v1/ai/budgets` | budgets doc | models filtered; balances; budgets + ETag | 422 invalid | |
| POST/GET `/v1/builder/projects` | `type=website`, `name`, `locale[]`, `templateId?` | project | 422, 402 quota | |
| GET/PATCH/DELETE `/v1/builder/projects/{id}` | PATCH + If-Match; DELETE confirm | project | 412 | delete = soft-delete + retention |
| GET `/v1/builder/projects/{id}/files` · GET `…/files/content?path=` | | file tree / content (size-capped) | 404 | |
| POST `/v1/builder/projects/{id}/changes` | `baseVersion`, `ops[]`, `source: user|ai` | `{diff, newVersion, risks[]}` | 409 `base_outdated`, 422 `op_invalid` | atomic |
| GET `/v1/builder/projects/{id}/versions` · POST `…/versions/{vid}/restoration` | | version list; new version | 409 | |
| POST/GET `/v1/builder/projects/{id}/previews` | `viewport?` | `{url, expiresAt}` | 429 | isolated origin |
| GET/POST `/v1/builder/projects/{id}/forms`; GET `…/form-submissions` | form schema | forms/submissions page | | PII masked for `viewer` |
| GET/POST `/v1/builder/projects/{id}/cms-collections` | schema, items | | 422 | |
| POST/GET `/v1/deployments`; GET `…/{id}`; GET `…/{id}/logs`; POST `…/{id}/rollback` | `projectId`, `target`, `environment` | `202` deployment `{id,state,operationId,url}` | 403 `approval_required`, 409, 422 `unsupported_capability` | smoke check + auto rollback |
| GET/POST `/v1/admin/ai/model-providers`; GET `/v1/admin/ai/runs` | | provider config; run metadata | | admin run view = metadata only |

## 7. Database migrations (owners: `ai`, `builder`, `deploy`; M09 creates all three; ranges in manifest)
| Table | Key columns / notes |
|---|---|
| `ai.model_providers` | tenant-less; `code`, `adapter`, `region`, `data_terms jsonb` (human-attested), `enabled`, `vault_ref`, `rate_card_version` |
| `ai.sessions`, `ai.messages` | `org_id`, `project_id?`, `created_by`; messages `content_encrypted?`, `content_hash`, `classification` |
| `ai.runs` (**single run table**) | `org_id`, `session_id`, `kind`, `state`, `operation_id`, `budget jsonb`, `reserved_credits`, `spent_credits`, `tokens_in/out`, `model_ref`, `data_region`, `checkpoint jsonb`, `version` |
| `ai.artifacts` | `org_id`, `run_id`, `type` (requirements/architecture/evaluation_report/…), `payload jsonb`, `schema_version` |
| `ai.model_usage` | append-only; `org_id`, `run_id`, `call_id` unique, `model_ref`, `tokens_in`, `tokens_out`, `estimated bool`, `cost_minor`, `credits` |
| `ai.budgets`, `ai.credit_balances` | org/project scopes; balance = projection (rebuildable from ledger) |
| `builder.projects` | `org_id`, `workspace_id`, `type='website'` (later webapp/mobile), `name`, `locales[]`, `head_version_id`, `deleted_at`, `version` |
| `builder.project_files` (**single file store**) | `org_id`, `project_id`, `version_id`, `path`, `content_hash`, `storage_ref`, `size`, `mime`; unique `(version_id,path)` |
| `builder.project_versions` | `org_id`, `project_id`, `parent_id`, `site_model jsonb`, `label`, `created_by`, `source` |
| `builder.changes` | `org_id`, `project_id`, `base_version_id`, `ops jsonb`, `diff jsonb`, `result_version_id`, `source`, `run_id?` |
| `builder.previews`, `builder.pages` | preview token hash, expiry, origin; pages index (slug, locale, seo jsonb) |
| `builder.forms`, `builder.form_submissions` | submissions `payload_encrypted`, `ip_hash`, `classification='personal'`, `expires_at` |
| `builder.cms_collections`, `builder.cms_items` | typed schema; item versions published flag |
| `deploy.deployments`, `deploy.deployment_logs`, `deploy.builds` | `org_id`, `project_id`, `version_id`, `target_ref`, `state`, `artifact_ref`, `previous_deployment_id`, `smoke jsonb`; logs append-only |
RLS everywhere except `ai.model_providers`. Append-only: `ai.model_usage`, `deploy.deployment_logs`. Reversal: new tables; down scripts per docs/05 §2; production rollback via forward fix. Note: `builder.sandboxes`, `run_steps`, `tool_calls`, `evaluations` belong to M10 per docs/05.

## 8. UI screens (ar RTL + en; loading/empty/error/forbidden on all)
| ID | Portal | Route | Purpose | Key states | Roles |
|---|---|---|---|---|---|
| UI-M09-01 | C | `/builder/projects` | Project list/cards, status, last deploy | empty→create | all read |
| UI-M09-02 | C | `/builder/new` | Wizard: describe business, language, template, budget cap | credits insufficient; residency denied | owner/admin/developer |
| UI-M09-03 | C | `/builder/projects/[id]` | **Builder workspace**: chat panel, canvas (responsive preview), property inspector, code/diff tab, run timeline | generating (SSE), approval pending, conflict, budget exceeded | read all; edit write roles |
| UI-M09-04 | C | `/builder/projects/[id]/versions` | Version history, compare, restore | | owner/admin/developer |
| UI-M09-05 | C | `/builder/projects/[id]/seo` | SEO settings & score report | | write roles |
| UI-M09-06 | C | `/builder/projects/[id]/forms` | Forms, submissions (masked for viewer), spam stats | | write roles |
| UI-M09-07 | C | `/builder/projects/[id]/cms` | Collections/items editor | | write roles |
| UI-M09-08 | C | `/builder/projects/[id]/deployments` | Deploy (target site, domain), approvals, logs, rollback | deploying, smoke failed→rolled back | owner/admin/developer |
| UI-M09-09 | C | `/builder/runs/[id]` | Run detail: events, approvals, cost | resumed/cancelled | write roles |
| UI-M09-10 | C | `/ai/usage` | Credits balance, usage by project/model, top-up (quote→approve) | low-credit banner | all read; billing_admin top-up |
| UI-M09-11 | C | `/ai/budgets` | Org/project caps, alert thresholds | | owner/admin/billing_admin |
| UI-M09-12 | X | `/ai/model-providers` | Providers, regions, data terms attestation, rate cards, kill switch | two-person enable | platform_admin, security |
| UI-M09-13 | X | `/ai/runs` | Run oversight (metadata, cost, failures); content access only via break-glass with consent | masked content | support, platform_admin |
| UI-M09-14 | X | `/ai/quality` | Evaluation reports and trend vs thresholds | threshold breach | platform_admin |

## 9. Security, compliance & tenant isolation
- RLS and cross-tenant tests on every §6 endpoint; preview URLs unguessable (≥128-bit), org-bound, expiring.
- **Preview isolation** (S39.4) validated by tests: preview page cannot read console cookies/storage, cannot call internal API (no CORS, network policy), cannot reach metadata/internal IP ranges; CSP verified by automated header tests.
- **Prompt injection:** attack suite (≥50 cases: instructions in uploads, URLs, form text, HTML comments, ar/en) ⇒ 0 tool calls outside allow-list, 0 secret exfiltration, 0 cross-tenant data in output; model output never executed; output sanitized by renderer.
- **Spend safety:** budgets enforced pre-call; retries/fallbacks are budget-aware; kill switch ≤ 5 s effect (proposal).
- **Human approval** required for: plan acceptance, publish to production, deleting pages/projects/versions, any spend above budget, enabling auto-apply. Approver must differ from AI; approval tokens bound to run+action hash, expiry 24 h (proposal).
- Platform secrets never enter prompts (outbound secret scanner); model API keys in vault with per-provider egress allow-list.
- Residency: model routing via `ResidencyPolicyService`; stored prompts/outputs carry `data_region`; third-party model calls recorded with transfer-assessment id when applicable (per published rules — verify with counsel, HG-04-01).
- Forms: PII classification, encryption, retention, DSR coverage; anti-spam without third-party trackers by default.
- Audit events: `ai.run.created|completed|cancelled|budget_exceeded`, `ai.approval.granted|denied`, `builder.project.created|deleted`, `builder.change.applied`, `builder.version.restored`, `deployment.created|succeeded|rolled_back`, `ai.provider.enabled`, `ai.killswitch.toggled`, `ai.secret_scan.blocked`.

## 10. Metering & billing hooks
| Meter | Emit point | Quota/limit |
|---|---|---|
| `ai.tokens_input`, `ai.tokens_output` | after each model call (provider counts) | org/project/run token caps |
| `ai.credits_consumed` | rated from tokens per model rate card | credit balance pre-flight reservation |
| `builder.build_minutes` | per render/validate/build job | monthly allowance via entitlement |
Hosting consumption from deployed sites is M06 meters. Spend approval (M02) for top-ups and any deployment implying new paid hosting; quotas: projects/org, concurrent runs, preview count.

## 11. Automated tests
- **Gateway:** routing matrix (residency × capability × cost); fallback never crosses residency; budget reservation property test (random call sequences never exceed cap by more than one in-flight `max_tokens` cost); kill switch; duplicate usage events idempotent; token estimate flagged.
- **Runs:** state machine, checkpoint/resume after worker crash, SSE resume with `Last-Event-ID`, cancellation mid-step, approval expiry.
- **Agents:** schema-validated outputs; repair loop ≤2; moderation hook; mock-model golden tests (plumbing only).
- **Renderer:** snapshot tests for all components in ar and en; RTL logical-CSS lint (0 physical `left/right` in ar output except allow-list); HTML validity; link checker.
- **Editor:** op validation fuzz; conflict `409`; undo/redo identities; restore creates new head.
- **Preview isolation:** header/CSP tests; cookie/storage access from preview denied; SSRF attempts to metadata IPs fail.
- **Prompt-injection suite** (≥50 cases) and **secret-leak suite** (platform secret canaries must never appear in any prompt/output/log).
- **Deployments:** deploy→smoke→switch; injected smoke failure ⇒ auto rollback; rollback restores prior artifact hash; duplicate `POST /v1/deployments` same key ⇒ one deployment; cross-tenant deploy to another org's site denied.
- **Forms:** spam honeypot, rate limit, size limit, PII encryption at rest.
- **E2E (UI):** non-technical journey create→edit (visual + chat)→publish (fake hosting) in ar and en, keyboard-only pass, axe 0 serious/critical.
- **Load (proposal):** 50 concurrent runs on mock model; SSE 500 connections; preview render p95 < 3 s.
- **Evaluation harness:** 40 prompts (20 ar, 20 en) × 8 site categories; automated checks + blinded human rubric (owner-approved reviewers, ≥10 sampled sites).

## 12. Deliverables
Gateway + adapters (mock + real as enabled), runs engine, agents, templates (8), site-model schema + renderer, editor ops service, preview origin infrastructure (IaC + ADR), SEO/forms/CMS, deployment pipeline, OpenAPI for §6, migrations + reversal, UI §8, evaluation harness + rubric + report, runbooks (`ai-budget-incident.md`, `ai-provider-outage.md`, `preview-isolation.md`, `deploy-rollback.md`), demo script (prompt→site→edit→publish), `docs/reports/M09-report.md`, gate review draft.

## 13. Measurable acceptance criteria (thresholds are proposals pending owner approval, D-18/D-32)
| ID | Criterion | Evidence | Status |
|---|---|---|---|
| AC-M09-01 | Budget property test: across 1,000 randomized runs, spent never exceeds cap by more than one max single-call reservation; runaway-loop chaos (20 runs) all stop at cap | test log | PENDING |
| AC-M09-02 | Residency routing: 100% of calls for classes disallowed outside Kingdom are blocked or routed to an allowed provider in the 200-case matrix | test log | PENDING |
| AC-M09-03 | Prompt-injection suite ≥50 cases: 0 policy violations (out-of-allow-list tool calls, secret exposure, cross-tenant leakage) | suite report | PENDING |
| AC-M09-04 | Preview isolation tests all pass (cookie/storage/network/CSP); independent security review sign-off recorded | test log + review note | PENDING |
| AC-M09-05 | Canary platform secrets: 0 occurrences in prompts, outputs, logs, previews (scanner) | scan output | PENDING |
| AC-M09-06 | Renderer: 100% of components valid HTML; 0 physical-direction CSS violations on ar output; link check 0 broken | CI | PENDING |
| AC-M09-07 | Editor: 1,000 fuzz op sequences ⇒ 0 invalid saved versions; restore creates new head and preserves history | test log | PENDING |
| AC-M09-08 | Deployment: injected smoke failure ⇒ auto-rollback ≤ 120 s and prior artifact hash serving | test log | PENDING |
| AC-M09-09 | Duplicate deploy POST ×50 same key ⇒ 1 deployment; cross-tenant matrix 0 successes | test log | PENDING |
| AC-M09-10 | Metering: tokens/credits on fixtures equal injected usage exactly; duplicate call events add 0 | test log | PENDING |
| AC-M09-11 | UI 14 screens e2e PASS ar+en; axe 0 serious/critical; keyboard-only publish path passes | CI report | PENDING |
| AC-M09-12 | **Quality (real model):** on 40-prompt eval set: HTML validation errors = 0 on ≥95% of sites; mobile Lighthouse-class a11y ≥ 90 and SEO ≥ 90 on ≥90% of pages, performance ≥ 80 on ≥80%; requirement coverage ≥ 90% (automated + human check); human rubric mean ≥ 4.0/5 on 10 sampled sites; Arabic RTL defects = 0 critical | eval report | BLOCKED-until-evidence (HG-09-01, D-18) |
| AC-M09-13 | Non-technical user (usability test, ≥5 participants, per owner) creates, edits and publishes a ≥3-page bilingual site unaided in ≤ 30 min (proposal) | session recordings/report | BLOCKED-until-evidence (HG-09-01, real hosting) |
| AC-M09-14 | Live publish to a real M06 CloudPanel node over HTTPS | URL, curl/openssl output | BLOCKED-until-evidence (HG-05-01/02, HG-06-01) |
| AC-M09-15 | Custom domain connected and serving the published site | DNS/HTTP evidence | BLOCKED-until-evidence (HG-07-01 + real domain) |
| AC-M09-16 | Real-provider data-terms attestation recorded for every enabled model provider | signed attestation ref in `docs/07` | BLOCKED-until-evidence (HG-09-01) |

## 14. Handoff
- **M10:** `ai.runs` extended with `run_steps`/`tool_calls`; run kinds `webapp|mobile|test-fix` activate; `builder.projects.type` extended; sandbox replaces renderer-only constraint; gateway reused; `deploy` extended with compute targets; evaluation tables (`ai.evaluations`) take over the harness.
- **M11:** workflow connectors for AI runs and deployments; template marketplace consumes site-model templates.
- **M12:** provider/model incident runbook, AI spend alerts, load test of gateway.
- Open: moderation provider, imagery licensing, model provider choices.

## 15. Compliance hooks checklist
- [ ] Every run/prompt/output carries `data_region`; residency evaluation logged
- [ ] Personal data in prompts/forms classified; retention per D-34; DSR export/erase covers sessions, messages, submissions
- [ ] Consent notice for AI processing and third-party model use recorded (M04)
- [ ] Audit events §9 emitted and tested
- [ ] Model data-terms attestation stored per provider
- [ ] Generated-content disclosure/terms owned by legal (HG)
- [ ] Preview/forms analytics: no third-party trackers without consent

## Completion instruction
Do not mark M09 DONE until every acceptance row is evidenced. Quality, usability, live publish, custom-domain and provider-attestation rows depend on HG-09-01, D-18, HG-05-01/02, HG-06-01 and HG-07-01 and remain BLOCKED-until-evidence; mock models, fake hosting and fixtures must never turn them into PASS. The agent may not mark any HG as granted, accept owner-approval thresholds on the owner's behalf, or enable a model provider whose data terms are unattested.
