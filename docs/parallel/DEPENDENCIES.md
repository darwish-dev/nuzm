# Dependencies between workstreams (and how each proceeds without waiting)

| Consumer | Needs | Provider | How the consumer proceeds now |
|---|---|---|---|
| 03 Benchmarks | recordings of a real model | 02 (S-AG4 live), owner | offline replay with REFERENCE recordings; mock-adapter recordings labelled `origin: MOCK`; live runner built behind the gate |
| 03 | tool-use evidence for scoring tool calls | 02 | uses existing validators; `supportsTools` read from the evidence API when present |
| 05 Builder tools | `ExecutionPort` / `BuildPort` | 04 | codes against the §2 sketch with `MockBuildPort` (scripted); real port never required for acceptance |
| 05 | provider usage/credit APIs | 02 | existing gateway + mock provider |
| 06 Deployment | build artifacts | 05 / 04 | fixtures of artifacts; in-memory publisher |
| 06 | domain/SSL lifecycle | existing `domains`/`hosting` modules | mock registrars and CloudPanel mock |
| 07 QA | everything | all | audits merged code on the integration branch; writes tests in its own paths; reports defects to the owner session |
| 02 | rate card (D6) | owner | configuration interface with versioned rate cards, tested with synthetic cards |
| 04 | real runtime | D-21, HG-10-02 | interfaces + mock runtime + policy; recommendation document |
Merge order proposed for the integration branch: 02 (small, mostly isolated) → 04 (contracts) → 03 → 05 → 06 → 07 tests, adjusted by readiness. No session blocks on another's merge.
