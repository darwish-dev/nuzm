# P3-S04 — Website Generation and Live Preview

Branch `feature/p3-s04-website` · worktree `.claude/worktrees/p3-s04` · Postgres 54354 · migrations 2330–2339. Read first: `CLAUDE.md`, `docs/phase3/PHASE-3-PLAN.md`, ADR-060 (preview origin isolation), ADR-062 (Tailwind styling), ADR-063 (web-app live preview), `apps/api/src/modules/builder/**`.

## Implementation prompt
You own turning a business brief into a **real, good, deployable website** and a **real preview** of it. Phase 2 left the website pipeline offline with scripted output. Make it model-driven through S03's loop (or the existing `website` run kind), validate quality automatically, and keep the preview isolated (ADR-060: separate origin, strict CSP, no cookies, HMAC tags).
Deliver: (1) generation quality: page structure from the brief, Arabic-first RTL + English, accessibility (WCAG 2.1 AA checks as automated gates), SEO metadata, responsive layout, image placeholders with licensing-safe assets, contact forms through the platform forms service, content editable via the existing edit schema; (2) a **static build pipeline** (no server code) that produces the artifact (hash-bound) consumed by S07, executed in the qualified runtime when real (S02) and in-process safe tooling for the offline path; (3) **automated website QA**: axe in both languages, Lighthouse-style budget checks (size, CSP, links), RTL layout checks, broken-link check; failures feed S03's repair loop; (4) the preview service: real URL on the isolated origin with expiry/revocation, viewport selector, cross-tenant isolation tests (keep the tamper tests deterministic), preview of AI branch vs published; (5) versioning: each generation/edit is a version with diff and restore (existing version service), publishing hand-off to S07.
## Scope boundaries
In: builder module (website, previews, forms, CMS), website templates/assets, preview UI. Out: loop internals (S03), server-side apps (S05), hosting (S07).
## Acceptance criteria
- W1 **T1 part 1:** from one synthetic Arabic brief and one English brief, the real model produces a complete business website (home, about, services, contact, ≥ 5 pages) that passes the automated QA gates (axe 0 violations ar/en, no broken links, CSP strict, size budget) — evidence record with model, tokens, cost, files, QA results.
- W2 Real preview served on the isolated origin: tamper/other-host/expired/revoked cases 404; cookies ignored; verified in the browser E2E ar+en.
- W3 Edit-by-prompt on an existing site produces a minimal diff (not a rewrite) and a new version; restore works.
- W4 Hand-off to S07: artifact hash matches what the deploy target serves (T1 part 2 is S07's evidence).
- W5 Offline path unchanged: all Phase 2 website/builder suites green.
## Dependencies
Needs: S03 (loop) + S01 (model) for live generation; S07 for deploy. Offline QA gates and templates are unblocked now.
## Human gates
Provider approvals; publishing to a real host is S07's approval; customer data not allowed (synthetic briefs only).
## First tasks
Merge `integration/phase3`; build the QA gate runner (axe/links/CSP/size) as a library + CLI usable on any artifact directory; improve templates for RTL/a11y/SEO; preview determinism tests; `REPORT-P3-S04.md`.
