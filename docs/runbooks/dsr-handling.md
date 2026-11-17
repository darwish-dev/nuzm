# Runbook — data-subject requests and data exports (M04 S14b)

Covers access, correction, deletion and portability requests (`/v1/compliance/data-subject-requests`) and organization data exports (`/v1/compliance/data-exports`). **Deadlines, wording and the refusal reasons are proposals until counsel confirms them (HG-04-01).** Nothing here is legal advice and nothing here has been reviewed by counsel.

## Who can do what
| Action | Who |
|---|---|
| Open a request about oneself; read own requests; download own archive | any member (`privacy:dsr:self`) |
| Open a request about someone else (an end user, a colleague), read all requests of the organization | owner, admin (`privacy:dsr:manage`) |
| Request, list and download organization exports | owner, admin (`privacy:export:manage`) |

A member never sees another member's request (404). A non-member of the organization gets 404 for everything.

## How a request runs
1. `POST /v1/compliance/data-subject-requests` with an `Idempotency-Key` returns `201 received` with `dueAt` (30 days, a proposal in `spec/compliance/defaults.yaml`) and `operationId`.
2. **Identity.** A member asking about themselves is verified by their session. An administrator asking about anyone else **must write down how the identity was checked** (`identityAttestation`, 10–500 characters, for example "signed form + call-back to the number on file"); without it the answer is 422 `dsr_identity_unverified`. The text is stored; it is not a verification the platform performs.
3. **Tasks.** One task per registered handler (identity, tenancy, billing, consent; later modules register theirs). `access` and `portability` export; `deletion` erases; `correction` rectifies (today only `displayName`).
4. **Close.** All tasks succeeded (including "no data of this kind") → `fulfilled`. Some did real work and others were refused or failed → `partially_fulfilled`. No real work and something refused or failed → `rejected` with the most specific reason (legal hold, then mandatory retention, account is global, last owner, unsupported, processing failed).
5. **Delivery.** For access and portability the request carries `downloadUrl`, a signed link (15 minutes; ask again for a fresh one) to an archive that is **encrypted at rest** and expires after 72 hours.

Free-text details are sealed (field encryption) and never returned or logged. Task records hold counts and flags, never the exported data.

## What deletion does and does not do
- **Removes** the person's membership of the organization (never the last owner).
- **Refuses**, with a reason in Arabic and English: invoices, credit notes, payments and the ledger (`retention_mandatory`, tax and accounting; D-34 and HG-03-04 decide the periods); consent evidence (`retention_mandatory`); the global account row, which belongs to the person across every organization and is referenced by records that must stay (`account_is_global`; closing an account is its own flow, not built yet).
- **Never bypasses a legal hold.** An active hold on the organization, or on a dataset a handler touches, refuses that handler with `legal_hold_active` **before** it runs. Reading (access, portability) is not blocked by a hold. See [legal-hold](legal-hold.md).
- Audit logs are append-only and are not erased.

## Deadlines
The sweep warns the organization's owners and admins (in-app notification and audit event) at **70 %** of the time to the deadline and escalates at **90 %**, once each. A request past its deadline shows `slaState: overdue`. Closed requests are never warned about. Run the sweep with `DSR_SCHEDULER_INTERVAL_SECONDS` > 0 (off by default, as the billing scheduler, ADR-017), or let the on-call person watch `slaState`.

## Running the jobs
- Each request kicks its own operation right after it is made (`DSR_KICK=off` disables this in tests).
- The periodic tick (`DSR_SCHEDULER_INTERVAL_SECONDS`) finds open requests, and **if `WORKER_DATABASE_URL` is set** it also claims any compliance operation across organizations (this is what recovers an export whose kick was lost). Without that variable, request an export again with the same `Idempotency-Key` (it replays the same export) or restart the API.
- Claims are atomic and leased (60 s). An operation whose worker died is taken over after the lease expires.
- A request whose operation was never created (a crash between the two writes) is repaired by the sweep after a minute.

## Exports
- `POST /v1/compliance/data-exports {"scope": "org"}` or `{"scope": "user", "subjectRef": "member:<id>"}` → `202`. At most **5** per organization in progress (422 `quota_exceeded`).
- **Production has no export sink until M08 decides it (D-07)**: the answer is `422 no_export_sink`; nothing is written anywhere. In development and test the archive goes to a local directory (`EXPORT_LOCAL_DIR`, default `.local/exports`, ignored by git).
- The archive is a gzip JSON document sealed with AES-256-GCM using a per-archive key that is itself field-encrypted (`FIELD_ENCRYPTION_KEYS`). Another organization's link is 404; an expired link or archive is 410.

## Handling a failure
| Symptom | Likely cause | Action |
|---|---|---|
| Request stays `received` | the job did not run (kick lost, scheduler off) | enable the scheduler, or wait for the sweep repair; the operation is in `platform.operations` kind `compliance.dsr` |
| Task `failed` with `processing_failed` | a handler error persisted after 3 attempts | read the task's `error` in `compliance.dsr_tasks` (kept for operators, never returned by the API), fix the cause, and open a new request; a closed request cannot change |
| `422 no_export_sink` | production deployment | expected until M08; tell the requester the export is not available yet and use the manual procedure counsel approves |
| `legal_hold_active` on deletion | a hold covers the organization or a dataset | tell the requester the data is preserved by obligation; do not release a hold to satisfy a request without counsel |

## What is not built
Admin DSR queue across organizations (PA-13, UI-M04-15), manual task completion, account closure, erasure of module data beyond the four handlers (M05+ register theirs), email delivery of notices (in-app only), verification of the identity attestation beyond the stored text, and counsel-approved deadlines and wording.
