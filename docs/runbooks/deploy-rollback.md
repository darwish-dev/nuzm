# Runbook — deployment failure and rollback (M09; DRAFT)

Pipeline: approval (human, bound to version + target + environment) → build → stage → smoke (staged: HTTP 200 on every page, TLS) → switch → smoke (live) → succeeded. A failed staged smoke leaves the previous artifact serving (`rolled_back`, no switch); a failed live smoke restores the previous artifact (`rolled_back`).
- **Read the story:** `GET /v1/deployments/{id}` and `/logs` (append-only). `smoke.results` lists failing paths.
- **Roll back a bad but "succeeded" deployment:** `POST /v1/deployments/{id}/rollback` (new Idempotency-Key). It restores the artifact of the previous succeeded deployment (by artifact hash) and creates a new deployment with `rollbackOf`.
- **Stuck deployment:** `platform.operations` kind `deploy.run`; a dead worker's lease expires and `DeployService.tick` re-claims it; the engine asks the publisher what is live first (reconcile before retry).
- **No publish path (422 `unsupported_capability`):** expected until M06 adds an artifact command to the node agent and a real node exists (HG-05-01/02, HG-06-01). Do not work around it by pushing files outside the pipeline.
- **Custom domain:** bind through the hosting domains API (M07 linkage); the build uses the site's primary domain as canonical base URL.
