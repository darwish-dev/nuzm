# CONTRACT-P3-S07-1 — wiring the deploy target to the hosting module (requests to the Master)

Author: P3-S07 · 2026-11-24 · Status: REQUEST (nothing here is applied; P3-S07 edits nothing under `apps/api/src/modules/hosting/**`, the spec, the ownership manifest, the SDK, `app.module.ts` or the lockfile).

What P3-S07 built is deliberately **port-shaped**: the deploy module imports nothing from the hosting module. The seams below are what must exist on the other side, and who owns them.

## 1. Hosting module: export the file manager (needs the hosting owner)
`FileManagerSiteTree` (`apps/api/src/modules/deploy/internal/file-manager-site-tree.ts`) needs a `FilesServiceLike`: the hosting `FilesService` already has the exact methods (`list`, `download`, `upload`, `mkdir`, `rename`, `remove`), but `apps/api/src/modules/hosting/index.ts` does not export it (it exports `HostingModule`, `NodesService`, `SitesService`, `HostingJobs`, the ports). **Request:** export `FilesService` (or a thin public provider with the same six methods) from the hosting module's `index.ts`. P3-S07 will not edit hosting.

Facts the hosting owner should confirm (READ in source on `main`, never run): a listing is capped at `HOSTING_TOOLS_LIST_MAX` (1000) and a folder over the cap is treated as an error by the adapter; downloads are capped at `HOSTING_TOOLS_MAX_DOWNLOAD_BYTES` (50 MiB); uploads at the plan's `uploadMb`; **one file per call, each opening its own SFTP session and writing one audit event** (so a 2000-file release is thousands of sessions: the live probe, spec section 4.5 question 8, measures it).

## 2. Hosting module: the document-root switch (needs the hosting owner and the owner's security decision)
`switchCurrent` / `currentRelease` cannot be done with the file manager (the guard refuses symlinks and renaming the web root). The transport takes an optional `DocrootSwitchPort` (`setDocroot(siteId, '.nuzm/releases/<id>' | null)`, `getDocroot(siteId)`). **Request:** the hosting line either (a) adds `v-change-web-domain-docroot` to its allow-listed command profile plus a read of the stored docroot, and provides a `DocrootSwitchPort` over it, or (b) says it will not, in which case option S2 (a rename swap rooted at `<home>/web/<domain>`) is a new, separate hosting method. Until one exists the transport **refuses** `switchCurrent` with `node_unavailable`; nothing is faked. This is a security-posture change of the hosting line (spec section 4.1): the owner decides (HOST-TRANSPORT decision memo, owner question 2).

## 3. Wiring in `apps/api/src/app.module.ts` / the deploy module (Master)
When 1 and 2 exist: in `DeployModule`, provide `SitePublisherPort` as `new HostingTargetPublisher(new HestiaSiteOps(hestiaAdapter, bindingResolver, opId), new deployTransport.FileManagerArtifactTransport(new FileManagerSiteTree(filesService, orgId, actorId), httpsProbe, docrootPort, { simulated: false }), stagingTarget, opts)`, **only** when `deploy.staging.real` is on and the target record carries `HG-05`/`HG-06` references. `bindingResolver` is the hosting module's org-scoped lookup (deploy site id -> node ref, account context, on-node name) and returns `null` for another organization's site. The per-request org/actor binding means the transport is built per call, not as a singleton. Not done by P3-S07: it needs `app.module.ts`, an HTTPS probe with a pinned resolver, and the hosting exports.

## 4. Nothing else
- No migration (the 2360-2369 block is unused), no OpenAPI change, no ownership row, no SDK change, no `messages.ts` key, no new dependency, no root script.
- Two new CLIs (`staging-checklist.cli.ts`, existing `live-track.cli.ts`) run with `npx tsx`; a root `package.json` alias (for example `deploy:staging-checklist`) is the Master's call.
- The domain package (`@nuzm/domain`, `deployTransport`) gained `FileManagerArtifactTransport`, its three ports, and `InMemorySiteFileTree`/`InMemoryDocrootSwitch`/`InMemoryStatusProbe` (SIMULATED). These are additive exports under `packages/domain/src/deploy-transport/**`, which the Phase 3 plan assigns to P3-S07.
