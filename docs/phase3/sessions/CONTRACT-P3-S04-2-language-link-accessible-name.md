# CONTRACT-P3-S04-2 — language-switch link: accessible name must contain its visible text (renderer fix)

From P3-S04 to the Master. Status: REQUEST (not applied). Evidence: real Chrome 158 + axe-core 4.14.0 over the built `services` template (10 pages, mobile 375 + desktop 1280): log `/private/tmp/claude-501/p3s04-browser2.log`. LABEL: the finding is LIVE-VERIFIED in a real browser (local loopback server, no network); the fix is NOT yet applied or re-verified.

## Finding
axe rule `label-content-name-mismatch` (WCAG 2.1 SC 2.5.3 Label in Name, level A) was reported on 15 of the 20 page loads: all 5 Arabic pages at both viewports and the 5 English pages at desktop only (the 5 English pages at mobile were not flagged; not investigated why, the markup is the same):

    <a class="lang ms-auto" href="/en/about/" lang="en" hreflang="en" aria-label="تغيير اللغة">English</a>

The visible text is "English" but the accessible name is "تغيير اللغة": speech-control users who say "click English" cannot activate it. The jsdom gate cannot see it (jsdom does not compute this rule), only the browser run does.

## Request (file not owned by P3-S04: `packages/domain/src/builder/render/page.ts`, `ui.ts`)
Smallest fix: drop the `aria-label` on that anchor (the visible native-language name plus `lang`/`hreflang` already states the purpose), OR make the name start with the visible text, e.g. `aria-label="English: تغيير اللغة"`. Either keeps `render.spec.ts` lines 112-113 (they match the tag prefix only). Re-verify with:

    heavy-slot.sh --weight 2 pnpm --filter @nuzm/api exec tsx src/modules/builder/internal/qa/build-site.cli.ts services <dir>
    heavy-slot.sh --weight 2 pnpm --filter @nuzm/api exec tsx src/modules/builder/internal/qa/website-qa.cli.ts <dir>/site --browser

Expected after the fix: `browser QA ... PASSED`. Rendering changes alter artifact hashes; template golden/determinism tests may need regenerating.

## Not a product bug (for the record)
The runner's `nav_order` warning was a false positive (it measured footer links too); fixed in `browser-qa.ts` (header menu only). A single `Failed to load resource 404` console error seen once on the first load was not reproduced on the second run and its URL was not captured: unexplained, NOT claimed as a favicon bug.
