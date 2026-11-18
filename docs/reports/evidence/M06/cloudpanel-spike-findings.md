# M06 / S24 — CloudPanel validation spike: findings (documentation analysis)

Method: documentation analysis only (no CloudPanel node exists; HG-06-01 is PENDING). Every row cites an official CloudPanel page, the date it was read (**2026-11-18**) and the version context. The newest release listed in the official changelog at read time is **CloudPanel 2.5.4 (2026-07-01)**. The CLI reference pages carry no version number of their own (footer: © 2026); we therefore pin findings to "docs as read on 2026-11-18, changelog head v2.5.4". Findings are summaries, not quotations. **No command is assumed to exist: anything not found on an official page is `not documented` or `unclear`.** Nothing here is `LIVE-VERIFIED`.

Sources (all https://www.cloudpanel.io unless stated):
- S1 `/docs/v2/` (index: lists CLI = Root User Commands + Site User Commands; no API section; no editions page)
- S2 `/docs/v2/cloudpanel-cli/root-user-commands/`
- S3 `/docs/v2/cloudpanel-cli/site-user-commands/`
- S4 `/docs/v2/frontend-area/tls/`
- S5 `/docs/v2/admin-area/backups/`
- S6 `/docs/v2/admin-area/users/`
- S7 `/docs/v2/requirements/`
- S8 `/docs/v2/changelog/`
- S9 `/license-terms/` (terms dated July 2020 per the page)
- S10 `/blog/cloudpanel-cli-interface/` (blog, older; command names differ from S2 in at least one place, so blogs are NOT treated as authoritative)
- S11 `/blog/cloudpanel-api/` and https://feature-requests.cloudpanel.io/posts/447/request-add-official-rest-api-support-for-cloudpanel (a feature request asking for an official REST API; a CloudPanel blog/tutorial text describes an API key flow that could not be confirmed on any official docs page)

## Capability × status

| # | Capability | Status | Evidence / note |
|---|---|---|---|
| 1 | A documented CLI exists (`clpctl`) | **documented** | S1, S2, S3. Root-user commands and site-user commands are separate pages. |
| 2 | Remote/network API for site management | **not documented** | S1 has no API section. S11: a public feature request asks for an official REST API; a blog/tutorial mentions an API key and `/api/v1/websites`, which is NOT on the docs index and conflicts with the feature request → treat as `unclear`, never build on it. |
| 3 | Authentication model of the automation surface | **documented (CLI), not documented (API)** | The CLI runs locally on the node (S2 root commands, S3 site-user commands run as the site user). There is no documented token/mTLS model for a remote surface. Network access therefore needs our own agent (ADR-020). |
| 4 | Site creation | **documented** | S2: `site:add:php`, `site:add:nodejs`, `site:add:static`, `site:add:python`, `site:add:reverse-proxy`, each with `--domainName`, a runtime version where relevant, `--siteUser`, `--siteUserPassword`. |
| 5 | Site deletion | **documented** | S2: `site:delete --domainName` with `--force` to skip the prompt. Leftover-crontab-on-delete was a bug fixed in 2.5.4 (S8) → cleanup must be verified by the wipe report, not assumed. |
| 6 | Site listing / query / lookup by name | **not documented** | S2 documents `user:list` and `vhost-templates:list` only. No `site:list`/`site:show`. → `findByToken` and `inventory` must be answered from the agent's own registry plus filesystem facts, not from clpctl. |
| 7 | Idempotent creation (client token, "exists" semantics) | **not documented** | No page states the behaviour of `site:add:*` on an existing domain. → reconcile-before-retry through our own token-in-site-name convention + agent registry. |
| 8 | Machine-readable output (JSON) | **not documented** | No page documents an output-format option. → agent wraps each command and returns its own typed JSON result; raw stdout is only evidence. |
| 9 | Per-site Linux user | **documented (creation) / unclear (hardening)** | S2 takes `--siteUser` for every `site:add:*`. Home directory mode, group layout, jail/chroot, cgroup limits: not documented → agent hardening step required and verified on a real node. |
| 10 | Per-site PHP-FPM pool / `open_basedir` | **unclear** | S8 (v2.5.2) mentions a PHP-FPM socket fix, which suggests per-site pools, but no page documents pool settings or `open_basedir`. |
| 11 | Database creation for a site | **documented** | S2: `db:add --domainName --databaseName --databaseUserName --databaseUserPassword`. Database/user deletion and per-user privilege restriction: **not documented**. |
| 12 | Database dump/restore | **documented** | S2/S3: `db:export`, `db:import` (`.sql` / `.sql.gz`). A scheduled `db:backup` appears only in a blog/older docs (S10) and is **not on the current root-command page** → `unclear`. |
| 13 | vhost / domain management for an existing site | **not documented** | Only vhost *templates* (`vhost-template:add|view|delete`, `vhost-templates:list|import`) are documented; there is no command to add a domain alias or edit a site's vhost. → domain binding needs agent-side configuration on documented/system primitives, verified live. |
| 14 | TLS: Let's Encrypt issue/install | **documented** | S2 `lets-encrypt:install:certificate --domainName [--subjectAlternativeName]`; S4 (UI) requires a valid DNS record per domain. v2.4.1 (S8): issuance tests against LE staging first. |
| 15 | TLS: custom certificate install | **documented** | S2 `site:install:certificate --domainName --privateKey --certificate [--certificateChain]`; S4. The private key is an argument/file path → our agent must stage it from a vault ref into a 0600 file, never into argv logs. |
| 16 | TLS: automatic renewal | **not documented** | S4 says nothing about renewal. → Nuzm schedules renewal (≥30 days before expiry, proposal) by re-running the documented issue command; behaviour of re-issue is `unclear` until live. |
| 17 | Backups | **documented (UI/rclone), not usable as-is** | S5: remote backups via UI/rclone, vhost + home (excluding `.ssh`, `logs`, `tmp`); encryption, retention, DB inclusion, per-site schedule/restore via CLI: **not documented**. No CLI. → Nuzm backup = agent-run, per-site encrypted, to a `BackupSink` (D-07). |
| 18 | Quotas (disk, inodes, bandwidth, processes, memory) | **not documented** | Nothing on S2/S3. → system primitives (filesystem quotas / cgroup v2 / systemd slices) chosen at agent design time, verified live. |
| 19 | Usage reporting per site | **not documented** | → agent measures (disk/inodes via quota tools, bandwidth via per-site access logs). |
| 20 | Suspend / resume a site | **not documented** | → agent implements suspension as a documented-free primitive (vhost disable + process stop), verified live. |
| 21 | Panel users / roles | **documented** | S6/S2: roles admin, site-manager, user; `user:add|delete|list|reset:password`. These are *panel* users; Nuzm customers never get panel logins (isolation + licence). MFA behaviour on S6: not documented. |
| 22 | Versioning / CLI stability | **unclear** | A command name differs between a blog post (`db:show:credentials`) and the current docs page (`db:show:master-credentials`) (S10 vs S2): command names are not a stable contract. v2.3.0 added root commands (S8). → the agent records `clpctl` version in `inventory()` and refuses unknown versions via a probe-gated allow-list. |
| 23 | Security track record of the surface | **documented (changelog)** | S8: v2.3.x–2.5.0 fixed several privilege escalations (site user → root, clpctl wrapper, MySQL root-password leak to site user), command-injection and file-manager flaws. → CloudPanel isolation is NOT relied on alone; our own hardening + escape tests are mandatory, and the control plane never exposes clpctl directly. |
| 24 | Licence / edition constraints | **unclear → legal review (HG-06-01)** | S9 (terms dated July 2020): current version free; hosting the software **for third parties** and reselling/renting it require the licensor's written consent (§6.2/§6.3); no editions described. Whether "running Nuzm-owned nodes that host customers' *sites*" counts is a **legal question we do not answer**; recorded as blocking input to HG-06-01. |
| 25 | Platform requirements | **documented** | S7: Ubuntu 22.04/24.04/26.04, Debian 12/13; x86 and ARM64; ≥1 CPU core, ≥2 GB RAM, ≥10 GB disk. Ports/virtualisation: not documented. |
| 26 | Runtime types | **documented (names)** | S2: PHP (version option), Node.js (22/20/18/16/14/12 listed), static, Python (3.x), reverse proxy. Offered runtimes still come from the adapter **probe** per node, never from this list. |

The table has 26 rows (AC-M06-01 needs ≥ 8); rows with a split status are decided by their weaker half.

## Reading of the result
- The documented surface is **local, interactive-style CLI with no listing, no JSON, no vhost/domain edit, no suspend, no quotas, no usage, no backup CLI, no renewal story**, and a history of privilege escalations. It is *not sufficient* on its own for FR-HST-01..08 → recommendation (b) in ADR-020: a bespoke **node agent** that executes allow-listed commands, using documented `clpctl` commands where (and only where) row status is `documented`, and Linux system primitives elsewhere, each marked "verify live".
- Items whose behaviour must be confirmed on a real node (HG-06-01): rows 6-7 (existing-domain behaviour), 9-10 (hardening), 13, 16, 18-20, 22.
- UI scraping (the panel web UI) is rejected outright: the panel runs with privileges we would have to hand to a headless browser session, has no contract, and has a long fix history for auth/file-manager flaws.
