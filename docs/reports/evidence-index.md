# Evidence index

Index of evidence artefacts referenced by acceptance rows. **Live evidence is owner-recorded** (human gates); every entry below that is a fixture, mock or simulator result says so and never supports a LIVE-VERIFIED label (CLAUDE.md §5, §6). This file is started by the M05 adapter stream; other streams append their own sections.

## M05 — provider adapters (S18–S23)

| Id | Artefact | Kind | Label | Notes |
|---|---|---|---|---|
| EV-M05-A01 | `docs/reports/evidence/M05/mock-compute-conformance.json` | mock | NOT VERIFIED | 15/15, S16 |
| EV-M05-A02 | `docs/reports/evidence/M05/alibaba-ecs-conformance.json` | fixture (documented-shape simulator) | NOT VERIFIED | 15/15 |
| EV-M05-A03 | `docs/reports/evidence/M05/huawei-ecs-conformance.json` | fixture (documented-shape simulator) | NOT VERIFIED | 15/15 |
| EV-M05-A04 | `docs/reports/evidence/M05/contabo-vps-conformance.json` | fixture (documented-shape simulator) | NOT VERIFIED | 15/15 |
| EV-M05-A05 | `docs/reports/evidence/M05/verified-region-report-alibaba-none-2026-11-18.{json,md}` | generated, no account | NOT VERIFIED | HG-05-01 PENDING; Saudi NOT VERIFIED |
| EV-M05-A06 | `docs/reports/evidence/M05/verified-region-report-huawei-none-2026-11-18.{json,md}` | generated, no account | NOT VERIFIED | HG-05-02 PENDING; Saudi NOT VERIFIED |
| EV-M05-A07 | `docs/reports/evidence/M05/verified-region-report-contabo-none-2026-11-18.{json,md}` | generated, no account | NOT VERIFIED | HG-05-03 PENDING |

### Live verification (owner-recorded)
No live-verification run exists. When the owner runs one (`docs/runbooks/live-verification.md`), add the redacted raw evidence here with an id `EV-LV-<provider>-<date>-<n>` and record the result through `POST /v1/admin/live-verification/runs`.
