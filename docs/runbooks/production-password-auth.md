# Production password authentication

The API now has a real entrypoint (`apps/api/src/main.ts`). It binds only to IPv4 loopback on port 4000, checks that the migrated identity database exists, and uses the existing password, rate-limit, audit, CSRF, session and permission implementations. No development identity provider or demo users are started.

## First setup

Deploy the code with `DEPLOY_API` still unset/false, then run as root on the server:

```bash
bash /srv/nuzm/current/infra/deploy/setup-production-api.sh
```

This creates a dedicated PostgreSQL 16 cluster named `nuzm` on port 55440, separate from existing server databases. It generates random runtime/migration passwords, session and audit keys directly on the server, writes protected files in `/etc/nuzm`, migrates the database, provisions runtime-role logins, initializes a field-encryption key and starts the API. Existing configuration is preserved; partial configurations stop for review instead of regenerating keys.

After checking `/healthz` locally and registration/sign-in through the public website, set the GitHub production environment variable `DEPLOY_API=true`. Subsequent deploys migrate and restart the API/worker automatically. The web service's previously installed `localhost` systemd override must remain: Next.js normalizes loopback rewrite targets to `localhost`.

## Secret storage

The initial single-server implementation stores AES-256-GCM ciphertext under `/var/lib/nuzm/secrets` (0700, owned by `deploy`). Its independent key is in `/etc/nuzm/secret-store.key` (0640, root:deploy), outside releases and the ciphertext directory. Wrong keys stop reads and replacements. New secrets use exclusive creation; updates use atomic rename. This is a local encrypted store, **not a managed vault, KMS, or hardware-backed key service**. A compromise of the running API user can expose both the key and ciphertext. D-12's managed-vault work remains separate.

Securely back up the dedicated PostgreSQL cluster, `/etc/nuzm` and `/var/lib/nuzm/secrets`. Restoring ciphertext without its original key loses access to stored MFA/provider/field-encryption secrets. Never regenerate or rotate these files casually, and never commit or paste them into chat.

## External services

`AUTH_OIDC_ENABLED=false` enables password-only setup without inventing OIDC credentials. OIDC routes return a service-unavailable error until a real provider is configured. Email delivery remains unconfigured: verification/reset mail failures are recorded by the existing audit flow. Registration and password login work, but email verification and password-reset delivery require a real mail integration. Cloud, payment and AI providers retain their existing production capability restrictions; this change does not enable simulated providers in production.

## Validation

Local production-mode startup was exercised against a fresh, fully migrated isolated PostgreSQL cluster. Registration returned 201 and password login returned 200 with secure session cookies, including when connected as `nuzm_app`. Unit checks cover ciphertext persistence, wrong-key preservation, exclusive creation, private permissions, path traversal rejection and optional OIDC configuration. Server validation is still required after setup.
