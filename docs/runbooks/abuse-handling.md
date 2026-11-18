# Runbook — handling hosting abuse (M06 S27)

AUP text and the abuse policy are a **human deliverable** (HG-04-01 PENDING): this runbook describes the mechanics only.

**Sources:** detectors (sustained CPU ≥ 90 % of one core for 3 consecutive hours → `throttle`; ≥ 50 blocked outbound SMTP attempts in a report → `suspend`; process-name signatures → `suspend`; thresholds are PROPOSALS), inbound reports (staff open a case with `source=report`), staff observation.
1. **Triage** — admin → Hosting → Abuse. A case shows severity, reason code, evidence **references** (no content), actions taken. One open case per detector and site: a detector that keeps firing does not flood the queue.
2. **Act** — `PATCH /v1/admin/hosting/abuse-cases/{id} {action: notify|throttle|suspend, note}` (admin:hosting:abuse, step-up). `suspend` suspends the site with reason code `abuse` (the node confirms first); `throttle` halves processes/memory on the node; `notify` tells the organization owners/admins. Every action is audited (`hosting.abuse.case.actioned`).
3. **Appeal** — the customer sees reason code, state and actions (never evidence) and appeals (10–2000 characters). A **different** person than the one who actioned decides: `overturned` lifts the suspension/throttle and closes; `upheld` closes the case. The database refuses the same person for both.
4. **Close** — `{action:'close'}` (false positive / resolved) lifts a suspension caused by the case.
5. **SMTP egress** is restricted by default on the node (counted and blocked); exceptions are documented per site by the security team and are not a platform feature yet.
