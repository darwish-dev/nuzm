# Runbook — access review process (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED. Access reviews are S55 work: the endpoints below are declared in `docs/04` §2.12 and `spec/openapi/planned-paths.yaml` (M12, planned) but are **not in `spec/openapi/openapi.yaml`** on this branch. Item listing is not part of the contract: PA-07 / SCR-M12-04 (`GET /v1/admin/access-reviews/{id}/items`, `POST …/items/{iid}/decision`) is proposed and NOT approved, and the `audit` schema holds `access_reviews` only; so reviewing individual items through the API is BLOCKED until the SCR is approved. The quarterly cadence below is a PROPOSAL for the owner to decide.

## Purpose
Periodically confirm that every person and credential with privileged or broad access still needs it, revoke what is not needed, and keep evidence that the review happened. This covers admin access (platform roles) and customer organization access where the platform offers a campaign.

## Trigger / alert
Scheduled campaign (proposal: quarterly for platform staff roles, semiannual for customer-facing admin roles; owner decides); staff role change or departure; an incident involving access; a customer's audit request; the hypercare plan.

## Severity guidance
Not an incident. A review overdue by more than one cycle, or a revoke that failed to remove access, is a SEV3 finding (SEV2 if it leaves privileged access for a departed person).

## Preconditions / access
Campaigns: permission `admin:security` per the M12 prompt (to be confirmed against the repository's platform permissions on merge), admin realm, MFA. Reviewers are assigned per campaign and must not review their own access. Scope **for now: organization members** (the design also names API keys, delegated access and admin roles; those scopes are not available until the SCRs are approved).

## Steps
1. **Plan.** Fix the scope, the reviewers (roles, not shared accounts), the due date and the evidence format. Notify reviewers in advance.
2. **Create the campaign:** `POST /v1/admin/access-reviews` (idempotent) with `{scope, reviewers[], dueAt}`; list with `GET /v1/admin/access-reviews`. Record the campaign id.
3. **Prepare the evidence input.** Until item listing exists, export the current members per organization and platform role holders from the admin console (`GET /v1/admin/users`, `GET /v1/organizations/{orgId}/members` for organizations; both audited) and give each reviewer their list.
4. **Reviewers decide** each item: `keep` or `revoke` with a reason: `POST /v1/admin/access-reviews/{id}/decisions` with `{itemId, keep|revoke, reason}`. A reviewer not assigned gets 403; a decision on a closed campaign gets 409; repeating the same decision is idempotent.
5. **Revocation executes through the owning module** (design): membership removal, API key revocation, delegated grant removal. If an automatic revoke fails, perform it manually and record it: member removal `DELETE /v1/organizations/{orgId}/members/{userId}` (`member:manage`, recent MFA), API key `DELETE /v1/api-keys/{id}`; platform role removal has no endpoint yet (PA-12: `POST/DELETE /v1/admin/users/{id}/platform-roles`, proposed, NOT approved): until then it is a reviewed change by the platform owner with two people.
6. **Chase** undecided items at 50 % and 90 % of the window (proposal); escalate to the reviewer's manager at the due date. Undecided items at close are treated as `revoke` only if the owner approves that policy; otherwise they are listed as exceptions.
7. **Close** the campaign after a verification query shows 0 residual access for revoked items (AC-M12-04). Record exceptions with an expiry.
8. **Report** to the compliance officer: items reviewed, kept, revoked, exceptions, overdue reviewers.

## Verification
For each revoked item: the member, key or grant no longer exists or is inactive; sessions of removed members are invalid; the audit log contains `access_review.decision` events with reviewer and reason; the campaign is closed with a summary. No attestation of compliance is claimed: evidence only.

## Escalation
Security officer (owner of the process); compliance officer for evidence and audit requests; the reviewer's manager for overdue decisions; owner for exceptions of privileged roles.

## Communication draft
Reviewer request, EN: "You have been assigned an access review (campaign [id]). Please decide keep or revoke for each item by [date] UTC and give a reason for every revoke. Contact [role] with questions."
AR: "تم تكليفكم بمراجعة صلاحيات الوصول (الحملة [المعرّف]). نرجو اتخاذ قرار الإبقاء أو الإلغاء لكل بند قبل [التاريخ] بالتوقيت العالمي المنسّق، مع ذكر السبب عند كل إلغاء. للاستفسار تواصلوا مع [الدور]."

## Records to keep
Campaign definition, reviewer list, decisions with reasons (audit events `access_review.decision`), the pre- and post-review member lists (exported evidence with checksum), exceptions with approvers and expiry, the closing report.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18). End-to-end revocation test: AC-M12-04.
