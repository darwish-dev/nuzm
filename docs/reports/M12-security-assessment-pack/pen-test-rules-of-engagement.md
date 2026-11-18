# Penetration test rules of engagement (DRAFT)

> **DRAFT prepared by the agent on 2026-11-18. Not agreed, not signed, not reviewed by counsel.** Every number is a proposal for the owner and the vendor to settle. The independent pen test is HG-12-01 (D-28) and is BLOCKED/PENDING. Safe-harbour wording is marked "counsel to review" and must not be sent to a vendor before counsel has approved it.

Parties: Nuzm (`<COMPANY_LEGAL_NAME>`, owner `<OWNER_NAME>`) and the vendor (`<VENDOR_NAME>`, not selected). Scope: [pen-test-scope.md](pen-test-scope.md).

## 1. Authorisation and safe harbour (counsel to review)

> COUNSEL TO REVIEW. Draft intent only: Nuzm authorises the vendor's named testers to perform the activities in the agreed scope, against the staging environment only, during the agreed windows. Activity within these rules is authorised by Nuzm for the purposes of the engagement; Nuzm will not initiate legal action against the vendor or its testers for good-faith activity that stays within scope and these rules. Nuzm cannot authorise testing of systems it does not control (third-party providers, payment and government services, identity providers); the vendor must not test them. Activity outside scope or these rules is not authorised. Governing law, liability, indemnity, insurance and confidentiality terms: `<TO BE SET BY COUNSEL>`.

Regulatory and provider notes: the owner and counsel must check (a) whether any applicable regulation requires notice or approval of security testing, and (b) each third-party provider's published testing policy before any traffic can reach it. No claim about those requirements is made here.

## 2. Testing windows (proposals)

| Item | Proposal |
|---|---|
| Environment | Staging only; production is never tested |
| Start / end | `<START_DATE_UTC>` to `<END_DATE_UTC>` (UTC) |
| Daily window | `<HH:MM-HH:MM UTC>`, outside Saudi business-critical hours if staging is shared |
| Blackout | Any window the owner announces (deploys, load tests, DR drills); the vendor is told at least `<N>` hours ahead |
| Source IPs | Declared before the start (`<VENDOR_SOURCE_IPS>`); traffic from other addresses is out of the rules |
| Testers | Named individuals only (`<TESTER_NAMES>`), each with their own accounts |
| Identification | Requests carry a vendor header/value agreed per engagement (`<TEST_HEADER>`), no secrets |

## 3. Rate limits and load (proposals)

| Activity | Limit |
|---|---|
| Automated scanning | At most `<20>` requests per second per source IP, at most `<5>` concurrent connections |
| Authentication endpoints (login, MFA, reset) | Brute-force and credential-stuffing tests only against seeded test accounts, at most `<10>` attempts per minute per account unless agreed otherwise; lockout of seeded accounts is expected and reversible by Nuzm |
| Webhook endpoints | Use only the supplied staging test secrets; no flooding |
| Volumetric DoS | Prohibited |
| Resource-exhaustion tests (zip bombs, fork bombs, large uploads) | Only on the agreed targets (sandbox, hosting node) and only with prior written notice |
| Email/SMS/notification-triggering tests | Only to seeded addresses on a catcher domain `<TEST_MAIL_DOMAIN>`; never to real mailboxes |
| Spend/billing tests | Sandbox PSP and mock only; any test that could create billable provider resources needs explicit written approval (CLAUDE.md §5: billable provider calls are human-gated) |

## 4. Permitted and prohibited activity

Permitted within scope: authenticated and unauthenticated testing, tenant-isolation attacks between seeded orgs, protocol attacks on SSO/SCIM against Nuzm's endpoints, business-logic abuse using seeded accounts, controlled sandbox/hosting escape attempts against planted canaries, configuration/TLS review.

Prohibited: testing production; any third-party system; denial of service; social engineering or phishing of Nuzm staff or customers (unless agreed in writing); physical access; persistence beyond the engagement; pivoting from staging to any network not listed; accessing, copying or retaining real personal data; modifying or deleting data outside seeded orgs; sending spam or abusive content; publishing or sharing findings with anyone but the agreed contacts.

Data touched during testing is synthetic. Accidentally reached real data: stop, do not copy, report (see section 5).

## 5. Stop conditions

The vendor stops testing the affected target immediately and calls the emergency contact when any of these occurs:

1. Evidence of real personal data, real credentials or production systems.
2. A target outside scope is reached (a third-party host, another environment, a cloud metadata service with real credentials).
3. Staging becomes unstable or unavailable beyond what the agreed test explains.
4. A sandbox or hosting-isolation escape reaches the runner/node host or the control-plane network.
5. A critical vulnerability allowing platform-wide compromise is confirmed (notify, then pause exploitation; do not demonstrate further without Nuzm approval).
6. Any activity is requested or implied outside these rules.

Nuzm can also pause or end the engagement at any time (`<PAUSE_CONTACT>`); testers acknowledge within `<15>` minutes.

## 6. Reporting

| Item | Rule (proposal) |
|---|---|
| Critical findings | Out-of-band notice within `<24>` hours of confirmation to the security lead and emergency contact, by the agreed encrypted channel; exploit details not sent over unencrypted email |
| High findings | Daily summary during the window |
| Interim status | Weekly call: coverage, blockers, findings counts by severity |
| Final report | Within `<10>` working days of test end; draft first, then final after Nuzm's factual-accuracy review (not severity negotiation) |
| Severity | Per the severity policy in [pen-test-remediation-tracker.md](pen-test-remediation-tracker.md); vendor may add a CVSS vector; disagreements are recorded, not silently resolved |
| Format | PDF plus machine-readable findings (`<CSV/JSON>`) so the tracker can ingest them |
| Retest | Critical and high findings retested by the vendor after Nuzm marks them fixed; retest letter lists each id and result |
| Disclosure | No public disclosure by either party without written agreement; coordinated disclosure terms `<COUNSEL>` |

## 7. Credentials, evidence and data handling

- Credentials are delivered out of band, individually, and never emailed in clear or committed; they are rotated or disabled at the end of the engagement.
- The vendor keeps evidence encrypted and deletes it per the agreed retention period (`<RETENTION_PERIOD>`).
- Nuzm records which accounts were active and the traffic window so that log review can separate vendor activity from real incidents.
- Findings that reveal secrets: the vendor redacts them in the report; Nuzm rotates the exposed secret regardless of environment.

## 8. Emergency contacts (placeholders)

| Role | Name | Phone / channel |
|---|---|---|
| Nuzm emergency / on-call security | `<EMERGENCY_CONTACT>` | `<PHONE>` |
| Nuzm engagement owner | `<OWNER_NAME>` | `<CONTACT>` |
| Nuzm technical (staging reset) | `<ENGINEERING_CONTACT>` | `<CONTACT>` |
| Vendor lead tester | `<VENDOR_LEAD>` | `<PHONE>` |
| Vendor escalation | `<VENDOR_ESCALATION>` | `<PHONE>` |
| Counsel | `<COUNSEL>` | `<CONTACT>` |

On-call roster and escalation matrix are HG-12-03 deliverables (D-29); this table uses placeholders until they exist.

## 9. Sign-off

| Party | Name | Date | Signature |
|---|---|---|---|
| Nuzm owner | `<PENDING>` | `<PENDING>` | `<PENDING>` |
| Vendor | `<PENDING>` | `<PENDING>` | `<PENDING>` |
| Counsel review | `<PENDING>` | `<PENDING>` | `<PENDING>` |
