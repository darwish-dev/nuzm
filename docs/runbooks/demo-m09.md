# Demo script — prompt → site → edit → publish (M09; mock model, fake hosting)

Setup (local, never production): services started (`NUZM_PGPORT=54351 pnpm services:start`), migrations applied, API with `AI_LOCAL_REFERENCE=true` (registers `mock-model` and the in-memory hosting publisher), flags `ai.enabled` on, a funded wallet, a provider enabled through the admin console.
1. Console → Builder → New: describe the business (Arabic or English), choose languages and a template, set a budget cap.
2. The run timeline streams: requirements → architecture → **plan approval** (approve as owner/admin/developer) → pages → validated site → version 2.
3. Workspace: preview (isolated origin, mobile/tablet/desktop), edit a heading in the inspector (safe diff + undo), ask in chat for another change (proposed change set → accept).
4. Versions: compare, restore (creates a new head). SEO: score report. Forms: submit from the preview, read masked/unmasked submissions. CMS: publish an item.
5. Deployments: choose a hosting site → confirm the human publish approval (cost disclosure) → build → smoke → live URL; inject a smoke failure to see the automatic rollback.
Everything above uses a SCRIPTED model and a FAKE hosting node: it demonstrates plumbing, not model quality and not live publishing (both BLOCKED, see the M09 report).
