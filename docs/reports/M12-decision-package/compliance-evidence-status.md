# Compliance evidence status (M12 decision package; AC-M12-19)

Prepared by the agent 2026-11-18 from `docs/reports/M04-report.md`, `M04-gate-review.md`, `docs/runbooks/compliance-evidence.md` and `spec/compliance/controls.yaml`. **Nothing here states or implies that Nuzm meets, complies with or is certified under any regime.** `claims_compliance` is false for every control (file validation, a database CHECK and `pnpm compliance:claims-guard`). This file contains no recommendation to launch.

## What the control register and collectors produce

The register shows what exists: which controls are mapped to which features, what evidence was collected, and who reviewed it. The catalog `spec/compliance/controls.yaml` holds 12 controls in our own paraphrased wording, version 1, `status: PROPOSAL-NOT-REVIEWED`. Framework references are empty until the compliance owner supplies them (HG-04-02, D-17) and applicability is always `to_confirm`.

| Collector | What it records | Honest limit (from the runbook) |
|---|---|---|
| `db.ownership-rls-check` | Ownership and forced-RLS check against the live schema | Needs the migrated database |
| `db.classification-coverage` | Every column classified, with the column count | Classes are a proposal (D-14 OPEN) |
| `audit.chain-verification` | Every audit hash chain re-verified | The dev audit chain is empty; the audit key is a dev stand-in (D-12) |
| `db.migration-lint` | Migrations numbered, owned and checksummed | |
| `scan.secrets-and-lockfile` | Secret-pattern scan verdict and a digest of `pnpm-lock.yaml` | No vulnerability database is queried |
| `config.security-snapshot` | Security headers configured in application source | Not a probe of a running deployment or TLS |
| `compliance.ropa-coverage` | Every adapter kind and data class has a ROPA entry | Coverage of entries, not legal adequacy |
| `compliance.residency-hooks` | Every data-region table and adapter kind has a hook | Hook registry, not a legal assessment |

Each result is hashed (SHA-256 over collector, version and the result without timestamps) and stored per control and collector; running it again over the same state adds nothing. A failing collector still records its failing result. Collectors run under the admin database role.

Not built (stated by the runbook): setting a control's applicability from the register, automated review reminders, backup and access-review collectors, provider-region verification collectors, a sandbox-isolation collector. The access-review collector is listed there as M12 work; the author did not verify whether S55 added it.

Status of the collectors for this decision package: AC-M04-09 PASS in M04 (eight collectors, identical hash on re-run). **They were not re-run to write this file**; the owner or the parent session should re-run `pnpm compliance:collect-evidence` against the migrated database and attach the output before relying on it. The evidence report for AC-M12-19 is therefore not generated here.

## Compliance hooks (M12 §15) in this area

| Hook | Status known today | Where |
|---|---|---|
| Control evidence collectors green | PENDING (owner records); eight collectors passed in M04, not re-run | `ga-readiness-checklist.md` H-06 |
| Regulatory validation register reviewed (statuses owner-supplied) | PENDING; seeded, no row validated | H-07 |
| Retention periods per D-34 with counsel values | PENDING; policies seeded as PROPOSAL | H-02 |
| Breach-notification workflow exercised | PENDING; state machine tested, timers are proposals, no exercise recorded | H-03 |

## Rows only the owner can supply (cannot be attested by the agent)

| Row | What the owner or third party must supply | Status | Gate | Owner role |
|---|---|---|---|---|
| AC-M04-15 / counsel memo | Memo on PDPL role (controller/processor per data category), transfer rules, DPO, lawful bases, retention (D-14, D-16, D-17, D-34); counsel values loaded from owner-signed config. HG-CMP-01 is a docs/07 alias of HG-04-01 (early counsel review of cloud-service-provider classification, PRD R7) | BLOCKED | HG-04-01 | Legal |
| AC-M04-16 / NCA-CST | Determination of NCA and CST applicability, any registration or classification filing, framework control references, a human validator for each register row. Register is built; no row validated | BLOCKED | HG-04-02 | Legal/Security |
| AC-M04-17 / assessments and certifications | Third-party security and compliance assessments or certifications (for example an ISO 27001 scope, NCA assessments). Not producible by the agent | BLOCKED | HG-04-03 | Security |
| Counsel text | Consent, refusal and notification wording is marked `COUNSEL-TEXT-REQUIRED`; Arabic and English wording unreviewed | NOT VERIFIED | HG-04-01 | Legal |
| Legal values | DSR deadlines (30 days, warn 70 % / escalate 90 %), breach timers (24/48/72 h), retention periods, residency floor, region groups, data classes are PROPOSALS in `spec/compliance/*.yaml` | PROPOSAL | HG-04-01 | Legal |
| Breach-notification obligations | Legal timelines under PDPL or regulator rules, to be verified against current official text with counsel; encoded as configurable timers only | PENDING | HG-04-01 | Legal |
| Runbook review | Compliance runbooks not reviewed by the compliance owner (human) | NOT VERIFIED | HG-04-01 | Compliance owner |
| Export store | Production export sink absent; `422 no_export_sink` | BLOCKED | D-07 | Owner |

The agent can only record the status of these rows. In the platform, a validation can reach `validated` only with a document reference, a decided applicability and the signed-in person as validator (API 422 `validation_requires_evidence` and a database constraint); there is no automated path.

## Related

- [../blocked-register.md](../blocked-register.md) rows BR-044, BR-046..BR-050, BR-118.
- [../ga-readiness-checklist.md](../ga-readiness-checklist.md) G-20..G-23 and H-01..H-07.
- [evidence-index.md](evidence-index.md) (compliance section).
