# Nuzm — Saudi Compliance Track (draft)

Not legal advice. Every regulatory statement below is a **pointer to be verified against the current official text with counsel** (HG-04-01, HG-04-02). The platform's engineering objective is to make compliance *demonstrable* (controls, evidence, enforcement points), never to *assert* compliance. No document, UI label, API field or report produced by an agent may state that Nuzm "is compliant/certified/approved" with any regime.

## 1. Regimes in scope (applicability to be confirmed)
| Regime / instrument | Why it may matter | Engineering touchpoints | Applicability |
|---|---|---|---|
| Personal Data Protection Law (PDPL) and implementing regulations (SDAIA) | Nuzm processes personal data of customers, end users, registrants, mailbox users | Consent, DSR, ROPA, retention, transfer rules, breach notification, DPO | to confirm (D-16, HG-04-01) |
| Data residency / cross-border transfer rules (PDPL transfer provisions; sector rules; customer contracts) | Choice of provider regions, backups, AI inference, email vendors | `ResidencyPolicyService`, transfer assessments, `data_region` on all resources | to confirm (D-14, D-16, HG-04-01) |
| NCA Essential Cybersecurity Controls (ECC) | Baseline cybersecurity governance/controls for the organization | Control register mappings, evidence collectors, access reviews (M12) | to confirm (D-17, HG-04-02) |
| NCA Cloud Cybersecurity Controls (CCC) | Cloud service provider obligations if Nuzm is classed as a CSP | Tenant isolation, logging, data segregation, backup, exit | to confirm (D-17, HG-04-02) |
| Other NCA instruments (e.g., data/critical-system/telework controls) | Customer-driven or sector-driven | Mapped only if counsel/security officer lists them | to confirm (D-17) |
| CST cloud computing regulatory framework (service-provider registration/classification, data classification expectations) | Possible registration/classification of Nuzm as a cloud service provider | Registration filings are human; platform provides data/evidence | to confirm (D-17, HG-04-02) |
| ZATCA e-invoicing / VAT | Invoicing and retention | See `11-payments-billing-zatca-track.md`; retention parameter D-34 | to confirm (HG-03-03, HG-03-04) |
| SAMA rules (payments) | Only where Nuzm's payment flows touch regulated activity | Use licensed PSP, no card data stored (token refs only); marketplace payouts deferred (D-26) | to confirm (D-10, D-26) |
| Domain registry rules (.sa eligibility) | Saudi TLD registration | M07 eligibility gating | to confirm (D-19, HG-07-02) |

Applicability decisions are recorded in `compliance.regulatory_validations` by humans with evidence file references; defaults are `to_confirm` and enforcement defaults to the **more restrictive** reading until counsel decides.

## 2. Control mapping approach
**Catalog file:** `spec/compliance/controls.yaml` (seeded empty in bootstrap; populated in M04). It stores *our own paraphrased control statements* and framework control IDs supplied by the compliance owner; official text is not copied.
```yaml
- id: CTL-ACC-001                 # internal id
  title: Multi-factor authentication for privileged access
  frameworks: [{ framework: "<name>", version: "<ver>", ref: "<control id supplied by compliance owner>" }]
  applicability: to_confirm        # to_confirm | applicable | not_applicable  (human-set)
  owner_role: security_officer
  implementation: { status: not_started|partial|implemented|not_applicable, modules: [identity], milestone: M01 }
  evidence: [{ type: automated, collector: ci.rls-suite }, { type: manual, description: "Quarterly privileged-access review" }]
  review_cadence_days: 90
  last_review: { by: null, at: null, outcome: null }
  claims_compliance: false         # schema forbids true; validated in CI
```
Tables: `compliance.control_catalog` (loaded from file), `compliance.control_mappings` (control ↔ module/feature/evidence), `compliance.evidence_items`, `compliance.regulatory_validations`.
**Evidence types:** `automated` (collector output with hash), `document` (human upload ref), `attestation` (named human, date), `external-report` (auditor/pen-test, human only).
**Collectors (agent-built, M04+):** CI result digest; RLS/ownership test result; audit hash-chain verification; migration-lint result; dependency/secret scan digest; backup success/restore-test result (M08/M12); access-review export (M12); config snapshot (security headers, TLS config); provider capability/region verification reports (M05); sandbox isolation test report (M10).
**Statuses shown in UI:** "mapped", "evidence collected", "reviewed by <role>" — never "compliant".

## 3. Residency engine design
| Element | Design |
|---|---|
| Data classes (D-14 proposal) | `public`, `internal`, `customer-content`, `personal`, `financial`, `credentials`; table `compliance.data_classes` (seeded) ; every column/resource kind in `spec/db/ownership.yaml` gets a `classification`. |
| Region groups | `in_kingdom`, `gcc`, `eu`, `other`; registry keyed by ISO country; provider regions inherit from verified country (M05 populates `cloud.provider_regions`). A region is `in_kingdom` only if **verified** (probe evidence), never by name. |
| Policy | Per org: mode `in_kingdom_only` \| `allow_listed` (country list per class) \| `unrestricted_with_assessment`. **Platform floor** (admin, per D-14/HG-04-01) cannot be loosened by org; org may only tighten. Versioned in `compliance.residency_policies`. |
| Evaluate | `ResidencyPolicyService.evaluate({orgId, dataClass, targetRegion, purpose, processorId?, operation}) → { decision: allow\|deny\|requires_assessment, reasons[], policyVersion, assessmentId?, evidenceRef }`. Fail-closed on write paths when service/config unavailable. |
| Exceptions | An exception is an **approved** `compliance.transfer_assessments` row (approver ≠ requester, expiry, scope: class × region × processor) referenced by policy; expiry auto-revokes. |
| Logging | Every evaluate on a mutation path writes an audit event with decision and policyVersion; denials produce user-visible, non-technical reasons (ar/en). |
| Sub-processors | `compliance.ropa_entries` lists processors (PSP, email vendor, model provider, provider accounts) with region and data classes; `processorId` in evaluate must exist in ROPA else `deny`. |

### Enforcement points (module must call before acting)
| Milestone | Hook |
|---|---|
| M03 | Before sending personal/financial data to PSP; ZATCA submissions are regulator-mandated (log, exempt class `regulatory`) |
| M05 | Offers filtering, quote, routing, provisioning (`dataRegion`), snapshots/backups destination |
| M06 | Node selection by region; site backups destination |
| M07 | Registrant contact data to registrars (processor evaluation) |
| M08 | DB/bucket/mailbox/email vendor placement and backup region; transactional email content to vendor |
| M09 | Model gateway: prompt/output class vs model region/processor; builder asset storage |
| M10 | Sandbox node region, exports, build workers (incl. macOS vendor), Git remotes |
| M11 | Connectors to third-party systems; marketplace installs |
| M12 | SSO/SCIM data, DR copy location, audit archive location, support impersonation |

## 4. DSR and consent
- **Consent:** purposes defined in `spec/compliance/purposes.yaml` (id, description ar/en, lawful basis label supplied by counsel, required y/n). Records are append-only with `granted|withdrawn`, version of text shown, locale, source. Withdrawal is applied synchronously through `ConsentService.isAllowed()` checked by consumers (marketing email, analytics).
- **DSR types:** access, correction, deletion, portability (and restriction/objection if counsel lists them). States: `received → identity_verified → in_progress → fulfilled | rejected(reason) | partially_fulfilled`. Tasks (`dsr_tasks`) per module via a registered `DsrHandler` interface (each module implements `export(subject)`, `erase(subject)`, `rectify(subject, patch)`); erasure is refused for data under legal hold or mandatory retention (financial/ZATCA) with recorded reason.
- **SLA timers:** configurable per type; *proposal* defaults: acknowledge 5 business days, fulfil 30 calendar days with warning at 70% and escalation at 90% (placeholders until HG-04-01).
- **Portability export:** async operation produces an encrypted archive with expiring signed link; stored in-region.

## 5. Retention (proposals; D-34 / HG-04-01 define real values; all configurable per `audit.retention_policies`)
| Data | Proposed default | Notes |
|---|---|---|
| Invoices, credit notes, ZATCA documents | per tax law — **value from HG-03-04/HG-04-01**; engineering default = longest configured | cannot be erased by DSR |
| Ledger postings | same as invoices | append-only |
| Audit logs | proposed 13 months online + archive per policy; extended by M12 audit-retention | immutability: archive by partition, never row UPDATE/DELETE |
| Application logs/traces | 30–90 days (proposal) | PII-scrubbed |
| Backups | proposed 35 days (tiers per product) | deletion DSR applies by expiry, documented |
| Account data after closure | proposed 30-day grace then erase except mandatory retention | |
| DSR records | proposed 24 months | |
| Consent records | life of relationship + proposed 24 months | |
Legal hold (`audit.legal_holds`) suspends deletion for scoped orgs/resources; only compliance role may create/release; dual approval.

## 6. Breach / incident notification workflow
States: `detected → triaged → assessed (personal data affected? scope, classes, regions) → notification_decision (human) → notified (regulator / affected parties / customers as decided) → remediation → closed`. Timers are configurable placeholders; **statutory deadlines and recipients are human-defined (HG-04-01)**. The system produces the evidence pack (affected tables/orgs from audit, timeline, actions) but never sends regulator notifications automatically. Incident tooling is extended in M12 (`ops.incidents`); `compliance.breach_cases` links to incidents.

## 7. Regulatory validation process
| Step | Agent | Human/external |
|---|---|---|
| Collect applicability questions into register | creates `regulatory_validations` rows (status `open`) | counsel answers, sets applicability |
| Map controls to features | drafts mappings | security officer reviews |
| Generate evidence | collectors run, packs exported | — |
| Gap analysis | lists unmet mapped controls | prioritises, accepts risk |
| Assessments / certifications / registrations | **cannot** (prepare data room only) | auditors, regulators, filings |
| Sign-off | **cannot** | named humans record `validated` with document ref |
Validation rows cannot be set to `validated` without a document reference and a human user id (DB constraint + API rule).

## 8. Per-milestone compliance hook list (each milestone prompt §15 repeats the relevant rows)
M01 classify identity/tenancy columns; audit immutability. M02 classify metering/billing; usage events carry no content. M03 PSP/ZATCA hooks, financial retention. M04 builds everything above and retrofits M01–M03. M05 region verification evidence; residency filter. M06 backup region/isolation evidence. M07 registrant data processing/eligibility. M08 backups/restore region, email content handling. M09 model/data terms. M10 sandbox data handling. M11 connectors/marketplace data sharing. M12 audit retention, access reviews, DR, incident notification drills.

## 9. Human/external deliverables (agent cannot produce) 
| Item | Owner | Gate |
|---|---|---|
| DPO appointment / privacy officer | Owner | HG-04-01 |
| Counsel memo: PDPL role, lawful bases, transfer rules, retention, breach deadlines | Legal | HG-04-01 |
| NCA/CST applicability determination and filings/registration | Legal/Security | HG-04-02 |
| Policies (information security, acceptable use, retention, incident response) approval | Owner/Security | HG-04-01 |
| Customer-facing privacy notice, DPA/terms text | Legal | HG-04-01 |
| Third-party assessments/certifications | Security/auditors | HG-04-03 |
| Pen-test | External vendor | HG-12-01 |
| Sub-processor contracts with data terms | Owner/Legal | HG-08-01, HG-09-01 |

## 10. Risks
| Risk | Mitigation |
|---|---|
| Counsel decisions arrive late | Ship restrictive defaults; config-driven policies; no schema change needed to adopt values |
| Provider region misclassified as in-Kingdom | Only probe-verified regions; evidence artefact; periodic re-verification job (M05) |
| Backups/AI/email silently leave region | Mandatory hook per §3; catalog test enforces hook coverage for every `data_region` table |
| Over-claiming compliance in UI/marketing | `claims_compliance:false` constraint; copy review checklist |
| DSR erasure conflicts with retention | Refusal with reason codes; legal review of reason texts |
