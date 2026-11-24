# Runbook: a VPS that installs HestiaCP (S04)

Status: built and tested against mock providers/simulators; **NOT VERIFIED live** (HG-05-05, HG-05-06, D-53, D-54).

## 1. Configure (administrator)
1. Decide the approved Hestia version and review the per-OS installer scripts; compute `sha256sum hst-install-ubuntu.sh` / `…-debian.sh` (D-54).
2. Set `HESTIA_VPS_CONFIG` (JSON) on the API: `panelVersion`, `installerBaseUrl` (documented: `https://raw.githubusercontent.com/hestiacp/hestiacp/release/install`), `installerSha256 {debian?, ubuntu?}`, `panelDomain` (D-53), `callbackBaseUrl` (https, reachable from the provider's servers), `controlPlaneIps`, optional `placements` (default: Alibaba `me-central-1`, Contabo `EU`), optional timing (`registrationTtlMinutes` 180, `bootTimeoutMinutes` 20, `installTimeoutMinutes` 90, `readinessAttempts` 5, `holdRetryMinutes` 30). Missing/invalid = the product is not offered.
3. Provider side (HG-05-05/06): Alibaba vSwitch + security group in the console network settings (open 8083 only to `controlPlaneIps`); Contabo credentials. Run the provider catalog sync, then **approve images**: Admin API `PUT /v1/admin/compute/panel-images/{imageId}` with `{evidenceKind, evidenceNote}` (`live` only after a real install on that provider). An image is approvable only if the provider states cloud-init and Hestia documents its OS.
4. **Source address.** The registration is matched against the server's public address as the provider reports it, using the request's socket address (`req.ip`). The API has no `trustProxy` setting today: behind a load balancer every registration would carry the balancer's address and be refused (fail-closed). Either expose `/v1/bootstrap/panel/*` directly or add a reviewed trusted-proxy setting first.
5. Turn the flag `cloud.hestia_vps` on for a test organization; start the periodic sweep with `CLOUD_PANEL_INTERVAL_SECONDS` (≥ 5).

## 2. Watch
`GET /v1/admin/compute/panel-installs?stage=needs_attention` (and `held`). Stages: `create_server → waiting_boot → installing_panel → registering → readiness → ready`; side states `needs_attention` (code + detail) and `held` (no provider capacity in the sold region; retried in the same region, never moved).

## 3. Needs attention: what to do
| Code | Meaning | Action |
|---|---|---|
| `boot_timeout` | the server never ran the bootstrap | check provider console/serial log; customer or admin `POST …/panel/retry` continues waiting |
| `panel_dns_not_configured` / `dns_failed` | the panel name has no A record | configure D-53, then retry |
| `readiness_failed` | panel unreachable/unhealthy after N tries | check port 8083 reachability from the control plane, TLS pin; retry |
| `panel_permissions_too_broad` | the key can run more than the read-only profile | not accepted; reinstall the profile on the server or open a support case |
| `install_timeout`, `registration_expired`, `bootstrap_*_failed` | the script did not finish on the server | read `/var/log/nuzm-hestia-install.log` and `/var/log/nuzm-bootstrap.log` (root); retry extends the window of the SAME order/server and returns the command `sudo bash /usr/local/sbin/nuzm-bootstrap.sh` |
| `integrity_failed` | the installer's SHA-256 differs from the pinned one; nothing ran | NOT retried on that server (the user data cannot change). Fix the digest/URL (D-54) and, if a fresh server is needed, cancel and re-order — a wipe/reinstall is deliberately not automated |

## 4. Live verification (to do by a human with sandbox accounts)
Order one VPS per provider, with and without mail; confirm: the cloud-init ran (user data honoured on the chosen image), the digest check passed, `v-add-access-key` output field names and `API_ALLOWED_IP` setting name (taken from Hestia's sources, not the cited pages), the registration source address equals the provider-reported address, readiness probe passes with the read-only profile, `v-list-users` is refused, and stop/start/restart work with the panel link cut. Record the result per provider as LIVE-VERIFIED with evidence; until then everything stays NOT VERIFIED.
