# Runbook — control register and evidence (M04 S15)

The register shows **what exists**: which controls are mapped to which features, what evidence was collected, and who reviewed. It never says that Nuzm meets a regime. `claims_compliance` is false everywhere (file validation, a database CHECK, and `pnpm compliance:claims-guard`, which also fails the build if any screen, message or API text uses a claim word such as "compliant" or "certified").

## The catalog
`spec/compliance/controls.yaml` holds our own paraphrased controls. Framework references stay empty until the compliance owner supplies them (HG-04-02, D-17); applicability is always `to_confirm` (only a person with counsel decides otherwise, in the regulatory validation register). Load it:
```bash
pnpm db:migrate               # also loads the catalog
pnpm compliance:sync-controls # only the catalog
```
A bad file loads nothing. Controls removed from the file stay in the database (evidence may reference them) and are reported as orphaned.

## Collectors (automated evidence)
```bash
pnpm compliance:collect-evidence                        # all eight
pnpm compliance:collect-evidence scan.secrets-and-lockfile  # one
```
| Collector | What it records |
|---|---|
| `db.ownership-rls-check` | the ownership and forced-RLS check against the live schema |
| `db.classification-coverage` | every column classified, with the column count |
| `audit.chain-verification` | every audit hash chain re-verified |
| `db.migration-lint` | migrations numbered, owned and checksummed |
| `scan.secrets-and-lockfile` | the secret-pattern scan verdict and a digest of `pnpm-lock.yaml`; **no vulnerability database is queried** |
| `config.security-snapshot` | the security headers configured in the application source; **not a probe of a running deployment or of TLS** |
| `compliance.ropa-coverage` | every adapter kind and data class has a ROPA entry |
| `compliance.residency-hooks` | every data-region table and adapter kind has a hook |

Each result is hashed (SHA-256 over the collector, its version and the result without timestamps) and stored for every control that lists the collector. An item is immutable and unique per control, collector and hash: **running it again over the same state adds nothing.** A failing collector still records its failing result and the command exits 1: evidence is what was observed. Collectors run under the admin database role; the runtime role cannot write automated evidence (a row-level policy refuses it).

## Manual evidence and reviews
In the admin console (Compliance → Evidence) or `POST /v1/admin/compliance/evidence`: a **document** or **external report** needs a reference; an **attestation** needs a note. The signed-in person is the named human; nobody can attest for someone else. An attestation marks the control "reviewed by <role>", and shows "review overdue" once the control's cadence has passed.

## Mapping
Compliance officer, security or platform admin map a control to a module feature (Compliance → Controls, `POST /v1/admin/compliance/controls`). Mappings are append-only.

## Regulatory validation register
Open questions for each regime of docs/10 §1 are seeded. People answer them; **validated** needs a document reference, a decided applicability and the signed-in person as validator; the API (422 `validation_requires_evidence`) and the database both refuse it otherwise. There is no automated path to `validated`.

## Not built
Setting a control's applicability from the register, automated review reminders, backup and access-review collectors (M08/M12), provider-region verification collectors (M05), a sandbox isolation collector (M10).
