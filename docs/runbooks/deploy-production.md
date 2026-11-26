# Runbook: GitHub → production deploy (www.nuzm.dev, 89.116.29.136)

Web/admin deployment was verified on 2026-11-26. Workflow: `.github/workflows/deploy.yml`; server side: `infra/deploy/`. Production API setup is described in [production-password-auth.md](production-password-auth.md).

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

**API/worker are off by default.** The API entrypoint now supports production password authentication using a dedicated database and an explicitly provisioned encrypted secret store. Follow [production-password-auth.md](production-password-auth.md) before setting `DEPLOY_API=true`. Its startup health path is `/healthz`. External OIDC, outbound email and cloud/payment/AI capabilities require their own integrations; development stand-ins are not enabled by this setup. Redis is not needed for the current PostgreSQL-backed queues.

## Fast path (what was actually done on 2026-11-25)

The GitHub side (environment `production`, secrets `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS`, variables `DEPLOY_HOST`, `DEPLOY_USER`, `ADMIN_ORIGIN`) was set with `gh` and the private key was deleted locally. The server side is one command from your Mac; you type the server password at the ssh prompt:

```bash
ssh root@89.116.29.136 'bash -s' < infra/deploy/install-on-server.sh
```

Then do step 8 (first run) and step 7 (nginx and HTTPS) below, in that order. Confirm the host key fingerprint `SHA256:3CZNf9hsIe6mnDtGD7qWmt+D+1f/PT0t1EDHdH9twHQ` (ED25519) against your hosting panel before the first deploy; it is pinned in `DEPLOY_KNOWN_HOSTS`.

## One-time setup (owner; manual version of the same steps)

1. **Server packages** (Ubuntu/Debian assumed): Node 22 (`.nvmrc`) and `corepack enable` (pnpm 10 comes from `packageManager`), `rsync`, `nginx` (already present), `curl`.
2. **Prepare the server**: copy `infra/deploy/` to it and run `sudo bash bootstrap-server.sh` (read it first). It creates the `deploy` user, `/srv/nuzm`, the systemd units and a sudo rule limited to restarting `nuzm-*`.
3. **Deploy key**: on your machine `ssh-keygen -t ed25519 -f nuzm-deploy -C github-deploy -N ""`. Put `nuzm-deploy.pub` in `/home/deploy/.ssh/authorized_keys` (mode 600, directory 700). Delete the private key locally after step 5.
4. **Pin the host key**: `ssh-keyscan -t ed25519 89.116.29.136` from a network you trust, and confirm the fingerprint against the one shown in your hosting panel/console. Keep the output line.
5. **GitHub → repo → Settings → Environments → New environment `production`:**
   - Secrets: `DEPLOY_SSH_KEY` (contents of `nuzm-deploy`), `DEPLOY_KNOWN_HOSTS` (the line from step 4).
   - Variables: `DEPLOY_HOST=89.116.29.136`, `ADMIN_ORIGIN=https://admin.nuzm.dev`.
   - Optionally: required reviewers; limit deployment branches to `main`.
6. **Server env files** (root-owned, mode 640, never committed): fill `/etc/nuzm/web.env` and `/etc/nuzm/admin.env` with the runtime variables the apps need (they can start empty for the public pages).
7. **nginx + HTTPS** (run in the VPS web console as root, after the first deploy has put the files in place; nothing to paste, it ships with the release):
   - `bash /srv/nuzm/current/infra/deploy/nginx-https.sh check` is read-only and shows the current vhosts, certificates and whether the apps answer.
   - `AGREE_LE_TOS=yes bash /srv/nuzm/current/infra/deploy/nginx-https.sh admin` creates a new vhost for `admin.nuzm.dev` and requests its Let's Encrypt certificate (you accept the subscriber agreement by setting `AGREE_LE_TOS`). It touches nothing existing. Optional: `CERTBOT_EMAIL=you@example.com`.
   - `bash /srv/nuzm/current/infra/deploy/nginx-https.sh www` moves the old `www.nuzm.dev`/`nuzm.dev` vhost aside (to `/root/nuzm-disabled`), keeps its certificate and proxies to the web app. Routing is preserved: plain-HTTP requests to each name still redirect to the same name over HTTPS, both names are served over HTTPS (one certificate covers both), and no HSTS policy is added. The script records the HTTP answers before and after and undoes the cutover itself if they differ. It refuses if the web app is not answering on `127.0.0.1:3000` or if the old vhost also serves other domains.
   - `bash /srv/nuzm/current/infra/deploy/nginx-https.sh rollback` restores the old `www` vhost.
   - Every change archives `/etc/nginx` to `/root/nginx-backup-<time>.tgz` first, and `nginx -t` must pass before each reload. Status: NOT VERIFIED on the real server.
8. **First run**: GitHub → Actions → `deploy` → Run workflow, then watch it.

## Rollback and recovery

- Automatic rollback happens if web/admin do not answer on their ports after the switch.
- Manual: `ln -sfn /srv/nuzm/releases/<older-sha> /srv/nuzm/current && sudo systemctl restart nuzm-web nuzm-admin`.
- Database migrations are forward-only (`docs/05`); a code rollback does not undo them (expand/contract).

## Known limits

- Not verified on the real server. Release size is large (the web `public/` assets); `--link-dest` keeps repeat uploads small.
- `release.sh` installs all dependencies (dev included) because migrations use `tsx`.
- Deploy runs only after the whole `ci` workflow, including `full`, succeeds.
