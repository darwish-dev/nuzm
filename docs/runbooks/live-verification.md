# Runbook — live verification of a provider (M05 §5, LV-1..LV-6)

Status: PROPOSAL. **Every provider row is NOT VERIFIED today. HG-05-01 (Alibaba), HG-05-02 (Huawei), HG-05-03 (Contabo) and HG-05-04 (quotas/spend caps) are PENDING; no account or credential exists.** This runbook is for the OWNER. An agent never enables, triggers or labels a live job; a mock or fixture run is never PASS.

## What a live run proves (and what the fixtures cannot)
The adapters were built only from the vendors' published documentation and pass the conformance kit against simulators shaped from those pages. A live run is the only way to establish: acceptance of the hand-written request signers (Alibaba ACS3, Huawei SDK-HMAC-SHA256), the Saudi region in the account's own listing (Alibaba `me-central-1` "Riyadh", Huawei `me-east-1` "ME-Riyadh"), idempotency replay, lookup-by-tag/name consistency after create, delete/cancel behaviour, and the permissions the docs leave undocumented. Per-provider checklists: `spec/providers/live-verify.yaml` (`must_establish`).

## Preconditions (LV-1, LV-2)
1. Owner creates a **dedicated test account** (never production) with a least-privilege API user as documented in the adapter README, and records it as HG-05-0x with an evidence id in `docs/reports/evidence-index.md`.
2. Owner sets a spend cap (HG-05-04) in the provider console and in `NUZM_LV_SPEND_CAP_MINOR`; the runner refuses when the estimated cost exceeds it.
3. Credentials go into a **non-production vault** (file stub `NUZM_DEV_VAULT_FILE`; the production vault is BLOCKED on D-12 / HG-01-02). Networking for Alibaba/Huawei (VPC/VSwitch/subnet/security group per region) is configuration: `NUZM_LV_NETWORK_JSON`.
4. Resources created by the job carry the tag/marker `nuzm-live-verify` (Contabo: the `nuzm:<token>|` display-name marker).

## Run (LV-3, LV-4)
```bash
pnpm --filter @nuzm/adapter-live-verify build
NUZM_LV_PROVIDER=alibaba NUZM_LV_VAULT_REF=vault://dev/live/alibaba NUZM_LV_OWNER_HG=HG-05-01 NUZM_LV_OWNER_EVIDENCE_ID=<evidence id> \
NUZM_LV_SPEND_CAP_MINOR=<cap> NUZM_LV_CURRENCY=<ISO> NUZM_LV_EST_COST_MINOR=<estimate> NUZM_LV_REGION=<region> NUZM_LV_PLAN=<smallest eligible plan> \
NUZM_LV_IMAGE=<image> NUZM_LV_SSH_PUBLIC_KEY="<public key>" NUZM_DEV_VAULT_FILE=<file> NUZM_LV_RESULT_FILE=lv-result.json \
  node packages/adapters/live-verify/dist/bin.js
```
Without the `NUZM_LV_*` trigger variables it prints `NOT RUN` and exits 2 without any network call. Steps: probe → create the smallest eligible plan → inspect until running → stop/start/reboot → resize and snapshot only if the probe says supported → metrics → delete → **teardown verifier** (`findByToken` must find nothing live for the run token; residue ⇒ `FAIL`, page the owner, delete by hand in the provider console) → billing record (provider bills lag 24–48 h; an empty answer is recorded, not a failure).

## Record the result (LV-5, LV-6)
Index the redacted raw evidence in `docs/reports/evidence-index.md`, then record the run:
`POST /v1/admin/live-verification/runs` `{ jobId, status, reason, steps, evidenceIds, gateEvidenceId, spendCapMinor, currency, residualResources }` (admin permission `admin:provider:manage`). `LIVE-VERIFIED` is rejected unless the gate evidence id and at least one evidence id are present and residue is zero (API and DB CHECK). The console (UI-M05-15) shows labels; capability and region states in the matrix are updated by running the account **verification** (`POST /v1/admin/provider-accounts/{id}/verification`), whose evidence is `live` only when it was observed over the real network.

## After a successful run
- Alibaba/Huawei: re-run verification so the Saudi region (if the account lists it) becomes `verified` with live evidence; generate the verified-region report (`buildRegionReport`) into `docs/reports/evidence/M05/`.
- Mutating capabilities that the probe cannot prove read-only (Huawei: all; Contabo: provision/delete/actions) stay `unknown` until the owner decides how live results are promoted (open item: a capability-promotion step is NOT built; today they remain unsupported).
- Then, and only then, update the acceptance rows AC-M05-15..19 with the evidence links. Never convert BLOCKED to PASS from a mock or fixture run.
