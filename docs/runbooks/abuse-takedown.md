# Runbook — abuse report and takedown (M12 S57)

Status: DRAFT 2026-11-18. NOT VERIFIED. The AUP and the abuse policy are human deliverables (HG-04-01 PENDING); this runbook covers mechanics and escalation only. The hosting abuse case tool is described in `abuse-handling.md` (detectors, actions, appeal): read it first. Abuse outside hosting (compute, email, AI content, builder, marketplace) has **no case tool on this branch**: those paths are manual and marked below.

## Purpose
Receive an abuse report (phishing, malware, spam, illegal content, intellectual-property claim, attack traffic), decide quickly and proportionately, act reversibly, give the customer a way to appeal, and keep evidence.

## Trigger / alert
Inbound report to the abuse mailbox (address to be filled), registrar or provider complaint, detector output (hosting: sustained CPU, blocked SMTP attempts, process signatures), law-enforcement or regulator request (route to counsel at once), email bounce/complaint spikes (`email-deliverability.md`).

## Severity guidance (proposal)
SEV1: imminent harm to people or a court/regulator order with a deadline; SEV2: active phishing/malware serving or spam from our infrastructure; SEV3: policy violation without active harm; SEV4: low-confidence report awaiting information.

## Preconditions / access
Hosting: permission `admin:hosting:abuse` (admin realm, MFA, step-up). Other products: platform admin and security. Legal or regulator orders: only counsel decides (HG-04-01). Legal hold may apply to evidence: `legal-hold.md`.

## Steps
1. **Log and acknowledge** the report; assign an owner; take a UTC receipt time. Do not forward customer or reporter personal data beyond need.
2. **Triage.** Verify the content or behaviour yourself where safe (do not open malware on a workstation; use the security team's procedure). Decide: valid, invalid, needs more information, or legal request.
3. **Hosting site:** open or find the case in Admin → Hosting → Abuse. Act with `PATCH /v1/admin/hosting/abuse-cases/{id}` `{action: notify|throttle|suspend, note}`: prefer `notify`, then `throttle`, then `suspend` unless harm is active (then `suspend` first). Suspension with reason code `abuse` is confirmed by the node first; every action is audited (`hosting.abuse.case.actioned`). Evidence is stored by **reference** only.
4. **Other products (manual, no case tool):** an organization can be suspended by staff (`PATCH /v1/admin/organizations/{id}` `{status, reason}`, `admin:org:manage`, step-up; owners are notified) but this is blunt: use it only when narrower action is impossible, and record why. Email: the sending throttle and suppression rules in `email-deliverability.md`. Marketplace and AI-content moderation arrive with M09/M11 and are not on this branch.
5. **Notify the customer** with the reason code, the state and how to appeal; never include evidence that exposes the reporter or other people's data.
6. **Appeal:** the customer appeals within the case (10-2000 characters); a **different person** decides: `overturned` lifts the action, `upheld` closes. The database refuses the same person for both. Non-hosting appeals follow the same principle by hand.
7. **Close:** `{action: close}` for false positives or resolved cases (lifts a suspension caused by the case).
8. **Legal requests and content removal orders:** do not act on your own: send to counsel via the compliance officer; record the order reference; preserve evidence; comply only as counsel directs.
9. **Repeat offenders:** security and the compliance officer decide on termination under the AUP (human decision); billing treatment by finance (no refund decisions here).

## Verification
The suspended site or action is effective and visible to the node/provider; the customer was notified; the case shows action, decision and appeal state; no unrelated customer was affected; evidence references are stored.

## Escalation
L2 on-call → security officer; counsel through the compliance officer for legal orders and IP claims; owner for press or regulator exposure; provider or registrar contact if their complaint has a deadline.

## Communication draft
Customer notice, EN: "We received a report that [site/service] may breach our acceptable use policy ([reason code]). We have taken the following step: [notify/throttle/suspend]. You can appeal by [method] by [date] UTC. Reference: [case id]."
AR: "وردنا بلاغ يفيد بأن [الموقع/الخدمة] قد يخالف سياسة الاستخدام المقبول ([رمز السبب]). واتخذنا الإجراء التالي: [إشعار/تقييد/إيقاف]. يمكنكم تقديم اعتراض عبر [الطريقة] قبل [التاريخ] بالتوقيت العالمي المنسّق. المرجع: [رقم الحالة]."
Reporter reply, EN: "Thank you for your report. We are reviewing it and will act under our policy. Reference: [case id]." AR: "شكرًا على بلاغكم. نراجعه حاليًا وسنتصرف وفق سياستنا. المرجع: [رقم الحالة]."

## Records to keep
Report copy (minimal personal data), receipt and action times, case id and audit events, evidence references (not content), appeal and decision, legal order reference if any, closure note.

## Last exercised
NOT EXERCISED (drill pending, AC-M12-18).
