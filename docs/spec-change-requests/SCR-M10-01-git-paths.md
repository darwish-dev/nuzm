# SCR-M10-01 — exact Git sub-paths under `/v1/builder/projects/{id}/git/…` (STATUS: PROPOSED, NOT APPROVED)

docs/04 §2.9 uses an ellipsis (PA-09). Per the M10 prompt **no Git API code is written until the owner approves this SCR.** The storage and logic exist without HTTP (`GitStore`, `ChangeService`; plumbing only: no hooks, no working tree).

Proposed (all `builder:git`, org from token, 404 across tenants):
| Method + path | Purpose |
|---|---|
| GET `/git/branches` | branches with tip commit (`main`, `work/ai`) |
| GET `/git/commits?branch=&limit=` | commit log |
| GET `/git/diffs?from=&to=` | structural diff + capped unified patch |
| GET `/git/checkpoints` | tags `cp-*` |
| POST `/git/checkpoints` `{name, branch?}` | create a checkpoint (idempotent by key; 409 if the name exists) |
| POST `/git/checkpoints/{name}/restoration` | restore = a NEW version through the changes pipeline (history is never rewritten) |
Out of scope: push/pull remotes, force-push, branch deletion. Decision: owner. Recorded as open in the M10A gate review.
