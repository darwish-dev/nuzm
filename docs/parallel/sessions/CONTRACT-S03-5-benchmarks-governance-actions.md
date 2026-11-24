# CONTRACT-S03-5 — threshold-governance actions on the benchmark action route (documentation only)

- **Requester:** Session 03 · **Status:** REQUESTED (nothing blocks on it; no route, path, method, status code or table changed)
- **Contract:** `spec/openapi/openapi.yaml`, schema `AiBenchmarksAction` (an `action` enum and open `additionalProperties`)
- **Additive?** Yes. **Sessions affected:** 01 (Master), SDK consumers.

## 1. New actions (permissions in brackets)
Add to the `AiBenchmarksAction.action` enum: `propose_thresholds` [admin:ai:manage], `review_thresholds` [admin:ai:manage], `reject_thresholds` [admin:ai:approve]. `accept_thresholds` [admin:ai:approve] already exists; its behaviour changed (see §2).
Fields (all with `version` = the thresholds version in force, and the caller's `requestId`): `propose_thresholds {summary}`, `review_thresholds {verdict: approve|request_changes|reject, note}`, `accept_thresholds {noBaselineAllowed?}`, `reject_thresholds {reason}`.

## 2. Behaviour (already implemented and tested; no migration)
The owner's acceptance is RECORDED by a person after a proposal and an approving review by someone else (four eyes: the accepter is not the proposer; the reviewer is not the proposer or the accepter); it is never auto-set. Events are appended to the existing append-only record log (`ai.benchmark_records`, kind `threshold_acceptance`, subject `thresholds`, payload = the event); the current state is the fold of the log (`NOT_PROPOSED`, `PROPOSED`, `UNDER_REVIEW`, `CHANGES_REQUESTED`, `ACCEPTED`, `REJECTED`). A rejection also withdraws an earlier acceptance. A plain acceptance row written before this workflow is not an event and grants nothing. No schema change: migration range 2120-2139 was not needed.

## 3. Overview and run detail (already travel; documentation)
`AiBenchmarksOverview.thresholds.governance`: `{state, version, proposedBy, proposedAt, summary, reviews[{by, at, verdict, note}], decidedBy, decidedAt, reason, acceptance}`. `GET .../runs/{id}`: a non-UUID or unknown id answers 404 (it used to reach the database as a malformed uuid).
