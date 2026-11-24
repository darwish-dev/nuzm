# Runbook: GitHub → production deploy (www.nuzm.dev, 89.116.29.136)

Status: **built, NOT VERIFIED** — no deploy has run yet. Workflow: `.github/workflows/deploy.yml`; server side: `infra/deploy/`.

## How it works

1. Push to `main` → `ci` runs (`pnpm verify`, then `full`).
2. When `ci` succeeds, `deploy` starts in the GitHub **production** environment (add required reviewers there for a manual approval step).
3. It builds in GitHub (`pnpm build`), `rsync`s the tree to `/srv/nuzm/releases/<sha>/` over SSH, and runs `infra/deploy/release.sh` there.
4. `release.sh` installs dependencies, flips `/srv/nuzm/current`, restarts the services, health-checks, and **rolls back** on failure. The last 5 releases are kept.
5. A public smoke check requests `https://www.nuzm.dev/`.

Next.js bakes `ADMIN_ORIGIN`/`API_ORIGIN` into its routes at build time, so they are set in the workflow, not on the server.

## What runs where

| Service        | Port (127.0.0.1) | Public                       | Deployed                                                      |
| -------------- | ---------------- | ---------------------------- | ------------------------------------------------------------- |
| `nuzm-web`     | 3000             | `www.nuzm.dev` via nginx     | always                                                        |
| `nuzm-admin`   | 3001             | `admin.nuzm.dev` (new DNS)   | always                                                        |
| `nuzm-api`     | 4000             | never (web proxies it)       | only if variable `DEPLOY_API=true`                            |
| `nuzm-worker`  | —                | never                        | only if `DEPLOY_API=true`                                     |

**API/worker are off by default.** At the time of writing `apps/api/src/main.ts` is empty and the dev stack refuses `NODE_ENV=production`; a production API also needs a production vault, IdP, PSP and Postgres/Redis (D-42, D-15, HG items). Do not set `DEPLOY_API=true` before those exist. The `/health` path used by the API check is unverified.

## One-time setup (owner; nothing here is done by the agent)

1. **Server packages** (Ubuntu/Debian assumed): Node 22 (`.nvmrc`) and `corepack enable` (pnpm 10 comes from `packageManager`), `rsync`, `nginx` (already present), `curl`.
2. **Prepare the server**: copy `infra/deploy/` to it and run `sudo bash bootstrap-server.sh` (read it first). It creates the `deploy` user, `/srv/nuzm`, the systemd units and a sudo rule limited to restarting `nuzm-*`.
3. **Deploy key**: on your machine `ssh-keygen -t ed25519 -f nuzm-deploy -C github-deploy -N ""`. Put `nuzm-deploy.pub` in `/home/deploy/.ssh/authorized_keys` (mode 600, directory 700). Delete the private key locally after step 5.
4. **Pin the host key**: `ssh-keyscan -t ed25519 89.116.29.136` from a network you trust, and confirm the fingerprint against the one shown in your hosting panel/console. Keep the output line.
5. **GitHub → repo → Settings → Environments → New environment `production`:**
   - Secrets: `DEPLOY_SSH_KEY` (contents of `nuzm-deploy`), `DEPLOY_KNOWN_HOSTS` (the line from step 4).
   - Variables: `DEPLOY_HOST=89.116.29.136`, `ADMIN_ORIGIN=https://admin.nuzm.dev`.
   - Optionally: required reviewers; limit deployment branches to `main`.
6. **Server env files** (root-owned, mode 640, never committed): fill `/etc/nuzm/web.env` and `/etc/nuzm/admin.env` with the runtime variables the apps need (they can start empty for the public pages).
7. **nginx**: merge the `location /` proxies from `infra/deploy/nginx/nuzm.conf.example` into your existing vhost; add a DNS A record `admin` → `89.116.29.136` and a certificate for it. Then `nginx -t && systemctl reload nginx`.
8. **First run**: GitHub → Actions → `deploy` → Run workflow, then watch it.

## Rollback and recovery

- Automatic rollback happens if web/admin do not answer on their ports after the switch.
- Manual: `ln -sfn /srv/nuzm/releases/<older-sha> /srv/nuzm/current && sudo systemctl restart nuzm-web nuzm-admin`.
- Database migrations are forward-only (`docs/05`); a code rollback does not undo them (expand/contract).

## Known limits

- Not verified on the real server. Release size is large (the web `public/` assets); `--link-dest` keeps repeat uploads small.
- `release.sh` installs all dependencies (dev included) because migrations use `tsx`.
- Deploy runs only after the whole `ci` workflow, including `full`, succeeds.
