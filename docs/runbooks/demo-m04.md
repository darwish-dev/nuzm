# Demo: M04 (residency, privacy requests, retention, controls, breach cases)

Local only. Counsel inputs are **proposals** (HG-04-01): deadlines, retention periods and wording are placeholders, and nothing here states that Nuzm meets any regime.

## 0. Start
```bash
pnpm services:start && pnpm db:migrate      # also loads the control catalog
pnpm compliance:collect-evidence            # eight collectors, hashed evidence
pnpm --filter @nuzm/api dev:stack           # API :4000 + dev identity provider
pnpm --filter @nuzm/web dev                 # customer console :3000
pnpm --filter @nuzm/admin dev               # admin console :3001
```
Ports 3000, 3001, 4000 and 4010 must be free. The browser screens of this milestone have **not been run in a browser** (see the S15 report); this script is the plan for the first run.

## 1. Tighten the residency policy → a provisioning decision is denied
Customer console → Privacy → Data residency → mode **in the Kingdom only** → save. Loosening below the platform floor is refused with a message. The decision service answers `deny` with a reason in Arabic and English (`ResidencyService.evaluate`; the integration test `residency.int.spec.ts` drives it with the mock provisioning request, because no provisioning exists before M05).

## 2. A deletion request under a legal hold is refused with a reason
Staff: Retention (admin API) → a legal hold on the organization with a second approver. Customer: Privacy → Data requests → New → **Deletion** → send. The request ends `rejected` with the reason "the data is under a legal hold" (Arabic or English) and the membership is untouched. An access request for the same person still works and offers the archive link.

## 3. Add evidence → the control shows "evidence collected" / "reviewed"
Admin console → Compliance → Evidence → add an **attestation** to a control: the control shows "Reviewed by <your role>". The automated rows show collector names and hash prefixes; run `pnpm compliance:collect-evidence` twice: the second run adds nothing.

## 4. Open a breach case → evidence pack
Admin console → Compliance → Breach cases → open a case → triage → assess (name an organization) → a **second person** records the notification decision → record the notification or go to remediation → close. On the case, generate the **evidence pack** with a reason: it shows a digest and a JSON download. The platform sent nothing to anyone.

## What this demo does not show
A real regulator filing, counsel-approved wording, an in-region export store (D-07), the cross-organization DSR queue (PA-13), the data-class coverage screen, the platform-floor editor and simulator (SI-M04-8), ROPA/retention/assessment editing screens.
