# ADR-062: Generated websites are styled with Tailwind CSS, compiled at build time

- Status: **Accepted by the owner in the session of 2026-11-20** ("Real Tailwind output"); the agent recorded it, the owner decided it. Builds on ADR-060 (preview isolation).
- Scope: every website the builder generates (all templates and AI builds). The web-app and mobile builders are separate pipelines and are not changed by this ADR.

## Context
Generated sites were styled by one hand-written stylesheet (~160 lines) and looked plain. The owner asked for Tailwind in the creation of every site.

## Decision
1. **Utility classes in the markup.** The renderer (`packages/domain/src/builder/render`) emits Tailwind v4 utility classes next to a few semantic hooks (`sec`, `sec-<type>`, `tone-<x>`, `card`, `step` …) that the editor and the base layer key off. Only logical utilities are used (`ps-`, `ms-`, `text-start` …), so one stylesheet serves RTL and LTR; the physical-direction lint runs on the compiled file.
2. **Compiled on the server, never in the browser.** `renderSite` stays pure and synchronous: it returns the Tailwind *source* (design tokens as `@theme`, a small base layer) and the sorted list of classes the pages use (`RenderResult.tailwind`). `apps/api/src/common/site-css.ts` compiles exactly those utilities with the `tailwindcss` package (pinned `4.3.5`) into `assets/styles.css`. No CDN, no runtime script, no `@import` left in the output: the CSP of ADR-060 (`style-src 'self'`) is unchanged.
3. **Safe by construction.** A site's Tailwind source is produced by our code from validated tokens and re-validated hex colours; the loader refuses any import except the Tailwind package's own theme, preflight and utilities. No model- or user-authored class, style or CSS is ever emitted. Output is deterministic and cached by content.
4. **Called from the two places that persist a build**: a new version (`commitVersion`, which feeds previews and the Code view) and a publish build (`deploy.service`). The evaluation scorer uses the uncompiled render, since it only reads markup.

## Consequences
- New dependency `tailwindcss` in `apps/api` (MIT, no runtime dependency in generated sites). Compile cost is tens of milliseconds per build.
- Versions created before this change keep their stored files (and old stylesheet) until a new version is committed; a publish always renders from the model, so a published site gets the Tailwind output at its next publish.
- Tests: every class a page uses must produce a rule (a typo cannot stay unstyled), the compiled CSS has no physical-direction rules, is deterministic, and every template compiles.
- Reversal: restore `buildCss` of the previous commit and the plain `renderSite` calls; stored files are unaffected.
