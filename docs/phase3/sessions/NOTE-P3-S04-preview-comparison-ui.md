# P3-S04 note — "preview of the AI branch vs the published site"

Status: API-level support exists and is tested; the side-by-side UI is NOT built (see "Why").

## What works today (no new code needed)
`POST /v1/builder/projects/{id}/previews` takes an optional `versionId`, so any two versions can be previewed at once, each on its own isolated origin (`<token>.<previewDomain>`, ADR-060). An AI-generated version is a normal version (`source: 'ai'`, `runId` set), the version history lists it with its `isHead`/`source` flags, and `GET /v1/builder/projects/{id}?versionId=…&compareTo=…` returns the model diff between two versions. S04 adds (service level, see CONTRACT-P3-S04-1) a measurement of the change between two versions (`VersionArtifactService.compare`: sections/texts/pages changed, output files byte-identical or not, verdict none/minimal/moderate/rewrite).

## Why no UI yet
1. "Published" is a deploy concept (which version a release serves). That mapping belongs to P3-S07's release records; the builder cannot know it until S07 lands, and guessing it (e.g. "oldest named snapshot") would show the wrong site as "published".
2. The pane needs new user-facing strings (ar + en) in `packages/i18n/src/messages.ts`, which the Master owns; sessions append delimited blocks only through the Master's process.
3. A browser-verified screen needs the E2E stack, which cannot run while the Phase 2 regression holds the heavy lock.

## Proposed shape (for the Master to schedule once S07 exposes the release → version mapping)
`PreviewComparison` in `apps/web/components/` reusing `PreviewPane` twice (left: published release's version, right: chosen AI version), shared viewport and site-language controls, the `bare` prop `PreviewPane` already has, a diff summary line from `compare`, and "restore this version" wired to the existing restoration endpoint. Each iframe keeps `sandbox="allow-scripts"` (ADR-060 §6); the two tokens are never displayed.
