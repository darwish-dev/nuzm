# HOST-TRANSPORT: implementation-ready specification of the artifact transport

Author: Session 06 · 2026-11-24 · Status: SPECIFICATION (nothing here is built on the hosting side; the deploy side runs SIMULATED).
Evidence vocabulary: **SIMULATED** (in-memory stand-in) · **READ** (read in source or reports, not run) · **NOT VERIFIED** (needs a live node) · **LIVE-VERIFIED** (run, with an evidence record).
Companion documents: `STAGING-DEPLOYMENT-PLAN.md` (§3, §3a, §17), `HOST-TRANSPORT-DECISION-MEMO.md` (who builds it), `PHASE2-06-approval-inputs.md` (HG-05, HG-06).

**Scope.** Put a built STATIC site on a HestiaCP shared-hosting node and switch what the site serves, with rollback. It is **not** a way to run AI-generated server code: HestiaCP is shared hosting and no isolation between customers is verified (plan §3). Server applications need Session 04's isolated runtime and are out of scope.

**Boundary.** The hosting line owns the node access (SFTP session, vault, path guard, panel commands). The deploy module owns the release lifecycle. The two meet at ONE interface, `ArtifactTransportPort`, which lives in `@nuzm/domain` (`packages/domain/src/deploy-transport/`) so the hosting side can implement and test it **without importing the deploy module**. Nothing in this specification asks for a change to hosting code written by this session; the hosting owner decides whether and when to build it.

---

## 1. The port (exact, from `packages/domain/src/deploy-transport/contract.ts`)

```ts
interface ArtifactTransportPort {
  readonly simulated: boolean;
  putRelease(site, releaseId, artifact): Promise<ReleaseInfo>;          // {releaseId, hash, files, bytes}
  readReleaseHash(site, releaseId): Promise<string | null>;
  switchCurrent(site, releaseId): Promise<{ previousReleaseId: string | null }>;
  currentRelease(site): Promise<string | null>;
  probe(site, where: { release: string } | 'live', path): Promise<{ status: number }>;
  hasRelease(site, releaseId): Promise<boolean>;
  removeRelease(site, releaseId): Promise<void>;
  listReleases(site): Promise<string[]>;                                // oldest first
}
```

`site` is `{id, name, status, runtime, dataRegion, domain}`; only `id` addresses a site. `artifact` is `{hash, files: [{path, mime, content}]}`.

### 1.1 Operation semantics

| Operation | Required behaviour | Errors (`ArtifactTransportError.code`) |
|---|---|---|
| `putRelease` | Validate everything BEFORE the first byte (`assertReleaseId`, `assertArtifactAcceptable`). Write the whole tree into a NEW release. Never touch what the site currently serves. Atomic from the outside: the release is not visible (`hasRelease`, `listReleases`, `probe`) until complete; a cut-short write leaves nothing visible and a retry under the same id works. **Idempotent**: same id and same tree again returns the same `ReleaseInfo` and writes nothing; same id and a DIFFERENT tree is refused and the original is untouched. `ReleaseInfo.hash/files/bytes` are recomputed from what was written. | `invalid_release_id`, `invalid_path`, `empty_artifact`, `limit_exceeded`, `release_exists`, `site_not_found`, `node_unavailable`, `transfer_failed` |
| `readReleaseHash` | Recompute the manifest hash FROM THE NODE (list the tree, hash each file's bytes as stored). Never return a cached or remembered value. `null` when the release does not exist. | `site_not_found`, `node_unavailable` |
| `switchCurrent` | Make the release the served document root; return the release served before (`null` the first time). Unknown release: nothing changes. Concurrent switches end on one of the two. See §4 for how. | `release_not_found`, `site_not_found`, `node_unavailable` |
| `currentRelease` | Read what the node serves now, from the node. `null` before the first switch. | `site_not_found`, `node_unavailable` |
| `probe` | Plain HTTPS GET from the platform (outside the node) of `path` on the staged host or the live host; return the status code only (never the body). A path ending in `/` means its `index.html`. A missing path or release is `404`; "no live release yet" is not 200. TLS errors are reported as status `0`, never as 200. | `site_not_found`, `node_unavailable` |
| `hasRelease`, `listReleases` | Enumerate only complete releases of THIS site, oldest first (creation order). | `site_not_found`, `node_unavailable` |
| `removeRelease` | Delete the release's tree. The live release is refused. A missing release is a no-op (idempotent). | `live_release_protected`, `site_not_found`, `node_unavailable` |

### 1.2 Shared pure rules (import them, do not re-implement)

- **Manifest hash**: `artifactManifestHash` = sha256 over, for each file in ascending `path` order (JavaScript `<` on strings), `path + "\0" + sha256hex(content) + "\n"`. Pinned test vector: `CONFORMANCE_VECTOR` (`ab2e3dc0…eb44` for the conformance artifact). A hash implementation that drifts fails case T-01.
- **Release id**: `^[a-z0-9][a-z0-9-]{7,63}$`, and not `current` or `releases` (a deployment UUID fits). Anything else is `invalid_release_id`; it never reaches a filesystem path.
- **Artifact path** (`assertArtifactPath`): relative, `/`-separated, NFC UTF-8, at most 512 bytes and 8 levels; no empty, `.` or `..` segment; no leading `/`, no `\`, no control character (incl. NUL). Symlinks cannot be expressed (a file is bytes), which is what the hosting guard needs. Duplicate paths, **case-insensitively**, are refused.
- **Bounds** (`DEFAULT_TRANSPORT_LIMITS`, PROPOSED not decided): 2000 files, 60 MiB per deployment, 25 MiB per file (the hosting line's per-plan upload limit is 25 MB with a 60 MB ceiling). The plan's disk quota is checked before the first byte (`limit_exceeded`).

### 1.3 Error codes

`site_not_found` (missing, **or another organization's**: indistinguishable by design) · `release_not_found` · `release_exists` (same id, different tree) · `live_release_protected` · `invalid_release_id` · `invalid_path` · `empty_artifact` · `limit_exceeded` (files, bytes, per file, quota) · `node_unavailable` (not connected, path not available, production gate closed; **every** call of an unavailable transport throws this, none succeeds) · `transfer_failed` (cut short, node answered nonsense, input hash does not match its files). An error carries a message with no file content and no secret.

---

## 2. What the deploy side does with it (already built, SIMULATED)

`HostingTargetPublisher` (`apps/api/src/modules/deploy/internal/hosting-target.ts`): **stage** = site state check → hash check of the input → `putRelease` → `readReleaseHash` and compare (a mismatch removes the release and fails the deployment: `ReleaseIntegrityError`) → **smoke staged** via `probe({release})` → **activate** = `switchCurrent`, then prune beyond `keepReleases` (default 5, the live one never) → **smoke live** via `probe('live')`. **Rollback** = `switchCurrent` back to a retained release (no re-upload), or `putRelease` again when it was pruned. The target gate (approval refs, SIMULATED label, preview domain) is re-checked before stage, activate, restore and SSL; the transport itself does not know about approvals.

Retry rule (CLAUDE.md §4): after a timeout or an uncertain result, **reconcile before retry**: `hasRelease` / `readReleaseHash` for the same release id decide whether to write again. That is why `putRelease` must be idempotent and atomic.

---

## 3. What the Hestia side must provide (operation → mechanism)

Everything in this column is **READ** from the hosting line's reports and branch (HESTIA-S1, S2, S4, S5; ADR-067), or from the cited Hestia source; **none of it is run** (NOT VERIFIED).

| Port operation | Mechanism on a Hestia node | Constraint that shapes it |
|---|---|---|
| `putRelease` | SFTP as the site's account (`s-<hex>`): create `<release dir>`, write each file to a temporary name then rename, `mkdir -p` for nested paths | The REST API has no file upload. The existing file manager handles **one file per call**, is rooted at `<home>/web/<domain>/public_html`, refuses a symlink anywhere on a path, refuses renaming/deleting the root, and caps a file at the plan's limit (≤60 MB). It cannot write a tree and has no per-deployment limit: **a new tree-write method with the per-deployment bounds is needed** (on the hosting side, reusing its guard and session) |
| `readReleaseHash` | SFTP: list the release tree and read each file back (or compute remotely) | Reading back costs the same bandwidth as the upload for a full re-read; acceptable at the proposed 60 MiB bound; an optimisation (remote `sha256sum` over a panel/SSH exec) is not available through the allow-listed profile and is not proposed |
| `switchCurrent` / `currentRelease` | **Strategy S1 (probe first), see §4** | symlinks are refused by the file-manager guard |
| `hasRelease`, `listReleases`, `removeRelease` | SFTP directory listing and recursive delete under the release root | recursive delete must refuse the live release and anything outside the release root |
| `probe` | HTTPS from the platform to the staged host / live host; status code only | needs a staged host (§4.3) |
| site resolution, `site_not_found` | org-scoped lookup in the hosting module (the same resolution its file manager uses) | another organization's site must be indistinguishable from a missing one |
| node capability | `probe()` → `hosting.runtime.static` | reported by the probe, never assumed |

Needed from the **hosting module**, none of it present today: org-scoped site resolution, the vault `get` for the site password (D-12: the file manager is unavailable in production until that decision), the SFTP connector with the pinned host key, audit, quota, and the node-connected gate. This is why the file-manager session recommended the transport live **in the hosting module**.

---

## 4. The switch without symlinks

Two layouts were considered. The facts first.

**Verified by reading (not run):**
- The hosting guard refuses a symlink anywhere on a path, and refuses renaming the root `public_html`. So `current -> releases/<id>` is not available through it. (HESTIA-S5, plan §3a)
- Hestia's `v-change-web-domain-docroot USER DOMAIN TARGET_DOMAIN [DIRECTORY] [PHP] [RESTART]` exists in the Hestia source (script read in full, 137 lines: [source](https://github.com/hestiacp/hestiacp/blob/67a57a612b7ed22e6e5e1b8a4587ecd4287d8ea0/bin/v-change-web-domain-docroot)). It sets the domain's `CUSTOM_DOCROOT` and `CUSTOM_PHPROOT` to `~/web/<TARGET_DOMAIN>/public_html/<DIRECTORY>`, **requires that directory to exist and to resolve inside the target domain's folder** (else `E_NOTEXIST` / `E_FORBIDEN`), and applies the change with `v-rebuild-web-domain`. `default` restores the default root. The user and the domain must exist and not be suspended.
- That command is **not** in the hosting line's allow-listed command profile today (nothing in its docs or hosting module mentions it).
- Order quirk in the script (read, not run): when a custom docroot already exists it is cleared **before** the directory checks; if the new directory does not exist the script exits with the old value already cleared and **no rebuild**. A failed call can therefore leave a stored default root that the next rebuild would apply. The transport must verify the release directory exists (via the SFTP read-back) **before** calling it, and must read `currentRelease` back after.
- A forum thread reports `Error 3` when calling this command through the REST API while the CLI worked ([thread](https://forum.hestiacp.com/t/v-change-web-domain-docroot-problem/10896)); no confirmed cause.

**Not in the script, therefore unknown (NOT VERIFIED):** whether the rebuild reloads nginx/Apache gracefully (so requests never see a missing root), whether the REST API accepts the command for an allow-listed key, whether the setting survives later rebuilds triggered by other commands (SSL issue, domain changes), which config file stores it, and the behaviour with the proxy/PHP templates the plans use.

### 4.1 Strategy S1: releases inside `public_html`, switch by panel command (probe first)

```
~/web/<domain>/public_html/.nuzm/releases/<releaseId>/…     ← putRelease writes here (inside the file manager's existing root: no new root)
switchCurrent  = v-change-web-domain-docroot <user> <domain> <domain> .nuzm/releases/<releaseId>
currentRelease = read the domain's stored custom docroot back from the panel and map it to a release id (which panel command shows it is probe item 4: NOT VERIFIED)
```

- Fits the existing guard: every write is under `public_html`, no symlink, no root rename. The panel command is a **graceful config change**, not two renames, so there is no window with a missing document root (if the reload is graceful: UNKNOWN).
- **Exposure risk:** before the first switch, `public_html` is the served root, so a staged release is reachable at `https://<domain>/.nuzm/releases/<id>/`. After the first switch the served root is a release folder and the other releases are outside it. Consequence: stage the first release only on a domain that is not yet public, or accept that content is visible before it goes live; the transport must not claim otherwise. Whether a dot-directory is served is UNKNOWN.
- Adds ONE command to the allow-list (`v-change-web-domain-docroot`) and a read of the stored docroot. That is a security-posture change of the hosting line and needs its owner's decision.

### 4.2 Strategy S2: rename swap (fallback)

`web/<domain>/public_html → public_html.prev`, then `releases/<id> → public_html`: two SFTP renames, so there is a window of well under a second without a root, and the guard forbids renaming the root, so a **new method rooted at `<home>/web/<domain>`** is needed. Not atomic. Whether Hestia's rebuild commands preserve a replaced `public_html`, and ownership/permissions of the new directory, are UNKNOWN. Rollback is the same swap.

### 4.3 Strategy S3 / S4 (rejected / last resort)

S3 symlink `current`: refused by the guard; would need the guard to change. S4 copy the release into `public_html`: no cheap rollback (rollback re-uploads), a window of mixed files; last resort.

### 4.4 The staged URL

`probe({release})` needs somewhere to serve a staged release from. Under S1 a second, permanent **staging web domain per site** (`<site>-<tag>.<preview domain>`, ADR-060, separate registrable domain) whose docroot is pointed at the staged release with the same command, smoked, then the live domain is switched. Whether the panel allows `TARGET_DOMAIN` to be another of the same account's domains for this purpose is what the script says (target domain must be an object of the same user); everything else about the staging domain is NOT VERIFIED.

### 4.5 Decision to make at the live probe

Run S1 first (one probe session, plan §11 row 6 expanded below). If S1 passes the probe list, build S1; if it fails on graceful reload or on REST acceptance, build S2 and record the weaker guarantee in the evidence record (`switch: "rename-swap"`, `windowMs`). The conformance suite is the same for both.

**Live probe checklist (each answer goes in the evidence record, with the node's Hestia version):**
1. REST API: does an allow-listed key run `v-change-web-domain-docroot` (the forum `Error 3` case)?
2. Does a request during the switch ever see 404/502 (hammer the live URL at 20 req/s across 50 switches)?
3. Does the setting survive `v-rebuild-web-domain`, an SSL issue and a domain change?
4. Where is it stored (so `currentRelease` can read it back)?
5. Is `/.nuzm/…` served on a not-yet-switched site? Can an `.htaccess`/nginx rule hide it?
6. File ownership and permissions of files written by the account over SFTP; SFTP jail layout.
7. Does a replaced `public_html` survive rebuilds (S2 only)?
8. Maximum upload throughput for 60 MiB / 2000 files; time per release; the read-back cost.
9. Quota behaviour when the disk is nearly full during `putRelease` (must be `limit_exceeded`, nothing left visible).

---

## 5. Limits

2000 files · 60 MiB per deployment · 25 MiB per file · 8 levels · 512 bytes per path · `keepReleases` 5 (≥2; the live one never pruned) — **PROPOSED**; the hosting owner sets the final numbers from the plan quotas. Per-plan limits may be lower; a lower bound must be declared to the conformance rig (`rig.limits`), and the over-limit case then runs against it. The disk quota is checked before the first byte; retention keeps the tree inside the quota (5 × 60 MiB can exceed a small plan, so retention must be `min(keepReleases, floor(quota / typicalRelease))`: to be decided with the plans).

## 6. Failure and rollback semantics

| Failure | Required result |
|---|---|
| Transfer cut short, SFTP dropped, node restarted mid-put | `transfer_failed`; no partial release visible; a retry under the same id works (conformance T-19) |
| Stored bytes differ from what was sent | `putRelease` may succeed; `readReleaseHash` exposes it; the publisher removes the release and fails the deployment (T-18) |
| Switch call fails or times out | `currentRelease` is read before any retry; the deploy side reconciles instead of repeating blindly (CLAUDE.md §4) |
| Switch applied but live smoke fails | the deployment is rolled back by `switchCurrent` to the previous release; the failed release is retained for inspection until pruned |
| Same id, different tree | `release_exists`; never overwritten |
| Live release asked to be removed | `live_release_protected` |
| Node unreachable / production gate closed | `node_unavailable` for every call |

Rollback never needs the node's upload path when the target release is retained; if it was pruned, the deploy side uploads it again, verifies and switches.

## 7. Tenant isolation

One site per call; another organization's site answers `site_not_found` exactly like a missing one (T-16). A release id is scoped to its site: the same id on two sites is two independent releases. No path argument from a request ever reaches a filesystem path unchecked (release id and artifact paths pass the shared rules first). The site's SFTP credentials are the site account's own, so the node's account isolation is the second line; **its strength on a shared Hestia node is NOT VERIFIED** and no customer site goes on a shared node before the isolation checks (plan §11 row 11) pass.

## 8. Audit and metering

Audit (hosting module, per call): `deploy.transport.put` (site, release id, files, bytes, hash, outcome), `.switch` (from, to, mechanism `docroot-command|rename-swap`, outcome), `.remove`, `.refused` (code). Never file content, never a credential. The deploy module already audits the deployment lifecycle (`deploy.*`). Metering: bytes written and release count per site per day through the central pipeline (docs/12), no module bills directly; the event names and rates are Master/billing decisions (NOT DEFINED here). Every call carries the trace id.

## 9. The shared conformance test

`@nuzm/domain` → `deployTransport.artifactTransportConformanceCases(rig)` returns 19 cases `T-01 … T-19`; `runArtifactTransportConformance(rig)` runs them and returns pass/fail/skipped; `unavailableTransportConformance(transport, site)` is the refusal case for an unavailable transport. The hosting side adds one vitest file:

```ts
import { deployTransport as dt } from '@nuzm/domain';
const rig: dt.TransportRig = {
  name: 'hestia-sftp (SIMULATED node)', origin: 'SIMULATED',   // 'REAL' only against a live node, with the evidence record
  transport: new HestiaArtifactTransport(/* node mock or live */),
  siteA, siteB /* two organizations */, unknownSite,
  limits: { maxFiles: 2000, maxBytes: 60 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024 }, heavy: false,
  faults: { corruptNextPut, failNextPut },                      // optional; T-18/T-19 are reported skipped without them
};
for (const c of dt.artifactTransportConformanceCases(rig)) it(`${c.id} ${c.title}`, c.run);
```

| Case | Proves |
|---|---|
| T-01 | put, hash from the node equals the manifest hash, counts, pinned hash vector |
| T-02 | `putRelease` never switches live |
| T-03 | binary bytes and Arabic paths round-trip |
| T-04 / T-05 | idempotent put; different tree under an existing id is `release_exists` |
| T-06 / T-07 / T-08 | switch returns previous, current read back, unknown release changes nothing, rollback by switching back with no re-upload |
| T-09 / T-10 | remove rules (live protected, missing no-op), oldest-first listing |
| T-11 | probe: staged, live, nested index, missing path, missing release |
| T-12 / T-13 / T-14 | unsafe paths, bad ids, empty artifact refused; nothing left behind |
| T-15 | bounds (files, per file, tree) |
| T-16 | tenant isolation and `site_not_found` on every call |
| T-17 | concurrent put and switch |
| T-18 / T-19 | integrity read-back and cut-short put (fault injection) |

Today it runs against `InMemoryArtifactTransport` (`artifact-transport.conformance.spec.ts`, SIMULATED), and the same spec proves the suite can fail: six deliberately broken transports (put that switches, a read-back that echoes, removable live release, shared releases across sites, silent overwrite, plain `Error`) are each caught by the named case. A pass over a mock is SIMULATED; it becomes LIVE-VERIFIED only with the live record (`nuzm.staging-evidence/1`, plan §17) from a real node.

## 10. Acceptance for "the hosting-side transport is done"

1. All 19 cases pass over a Hestia node mock (SIMULATED) in the hosting module's own CI; no import from `apps/api/src/modules/deploy`.
2. The probe checklist (§4.5) answered on one real node, recorded, with the chosen switch mechanism.
3. `unavailableTransportConformance` passes when D-12 is not granted or the node is not connected.
4. The same 19 cases pass against the real node (`origin: 'REAL'`, `heavy` optional) and a track-G run (`live-track.cli.ts deploy`, release 1 → release 2 → rollback → smoke) produces a valid evidence record.
5. A named reviewer signs the isolation checks before any customer site is placed on a shared node.

## 11. What this specification does not decide

Who builds it (memo), the final bounds and retention, metering event names and rates, the strength of per-account isolation on a shared node, server applications (Session 04), production publish for customers (D-42), and the vault decision that gates the file manager in production (D-12).

---

## 12. Option B implemented (P3-S07, 2026-11-24): the transport over the hosting file manager's PUBLIC operations

Status: **implemented and SIMULATED**; nothing was run against a node. The owner's HOST-TRANSPORT decision is still open (memo options A to D); this is the option-B fallback of the memo, built so that whichever line the owner picks, the shared conformance suite is the same. It duplicates none of the hosting architecture: it uses only the six file-manager operations the hosting module already has (list, download, upload, folder, rename, delete), through a structural port.

Code: `packages/domain/src/deploy-transport/file-manager-transport.ts` (`FileManagerArtifactTransport`, ports `SiteFileTreePort`, `DocrootSwitchPort`, `HttpStatusProbePort`), SIMULATED stand-ins in `file-manager-transport.sim.ts`, the adapter over the hosting `FilesService` surface in `apps/api/src/modules/deploy/internal/file-manager-site-tree.ts`.

| Port operation | Built from | Verified? |
|---|---|---|
| `putRelease` | `mkdir` of `.nuzm/tmp/<id>-<attempt>` and its folders, one `upload` per file, read-back of the whole tmp tree and its manifest hash, ONE directory `rename` to `.nuzm/releases/<id>` (the only step that makes the release visible), then a zero-byte creation marker `.nuzm/index/<13-digit ms>-<id>`; any failure removes the tmp tree | SIMULATED (19 cases + 12 transport-specific tests). Directory-rename atomicity on a real SFTP/Hestia node: NOT VERIFIED (probe question 6, new) |
| `readReleaseHash` | `list` + `download` of every file, hashed with the shared manifest rule | SIMULATED. Cost on a real node (one session per file): NOT VERIFIED (question 8) |
| `hasRelease`, `listReleases` | `list` of `.nuzm/releases` and `.nuzm/index`, oldest first by marker name | SIMULATED |
| `removeRelease` | marker first, then recursive `remove` of the release folder; live release refused | SIMULATED |
| `switchCurrent`, `currentRelease` | **not available through the file manager** (symlinks and renaming the web root are refused by its guard). They call the injected `DocrootSwitchPort` (strategy S1, `v-change-web-domain-docroot`); without it they refuse with `node_unavailable` and nothing is faked. The transport verifies the release folder exists BEFORE the panel command and reads the stored docroot back AFTER it (the script's order quirk, section 4) | SIMULATED switch only; the real command is not in the hosting allow-list: NOT VERIFIED, owner decision (memo question 2) |
| `probe` | injected HTTPS status probe; "no live release yet" is 404 | SIMULATED probe; a real one needs a staged host (section 4.4): NOT VERIFIED |

Layout inside the site's web root: `.nuzm/releases/<id>/…`, `.nuzm/tmp/…`, `.nuzm/index/…` (strategy S1; the exposure risk of section 4.1 applies unchanged: before the first switch these folders are reachable under the served root, and a dot-directory being served is unknown).

Behaviour proven over the stand-ins (all SIMULATED): idempotent put, `release_exists` for a different tree under an id, cut-short transfer leaves nothing (T-19), wrongly stored bytes are caught at put time and nothing becomes visible (T-18), per-site serialisation of put/switch/remove (T-17), a panel that rejects the command leaves the previous release serving, a panel that answers OK without applying it is caught by the read-back, the plan's per-file and disk limits become `limit_exceeded`, a truncated listing or a symbolic link in a listing is an error (never a silent partial tree), another organization's site is `site_not_found` on every call.

Probe checklist additions (to section 4.5): 6b. Does a directory `rename` inside `public_html` over SFTP stay atomic with respect to a concurrent HTTP request (no window with a half-moved folder)? 8b. Wall-clock time and number of SFTP sessions for a 2000-file / 60 MiB release when every file is its own call. 10. Does the file manager's 1000-entry listing cap affect any release (a folder over the cap is refused by the adapter)?
