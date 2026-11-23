# D-42 and D-45 — what is decided, what is still open, and what must not be bypassed

Date: 2026-11-21 · Source of record: `docs/07-open-decisions-and-blockers.md` (rows D-42, D-45). This note adds no decision; it lists what remains and who acts.

## D-42 — platform object store (production gate, STILL CLOSED)
**Decided (owner, interim, 2026-11-20):** development filesystem adapter now; the provider adapter waits for the ADR-052 provider, whose selection is open.
**Built and verified against a signature-verifying fake only:** the S3-compatible adapter (own SigV4, private bucket checks, encryption check, presigned access, `selfTest()`), and `resolveKnowledgeStore`. In production it returns NO store unless ALL hold: complete S3 configuration, credentials resolved from the vault by the caller (environment keys refused), an `https` endpoint, and `KNOWLEDGE_S3_ATTESTATION=HG-…`. The filesystem adapter can never be selected in production. With no store, `KNOWLEDGE_INGEST_ENABLED` claims nothing and the worker says why.
**Still needed (human, none of it can be done by the agent):**
| # | Item | Owner |
|---|---|---|
| 1 | Provider and account (ADR-052) | owner |
| 2 | Region and residency (`data_region`), retention and lifecycle for archives, snapshots, previews | owner + DPO |
| 3 | Bucket: private, public access blocked, versioning/object lock policy, encryption (SSE-S3 or SSE-KMS key) | operator |
| 4 | Vault-held credentials with least-privilege policy for the library prefix | operator |
| 5 | `selfTest()` run against the REAL bucket, evidence recorded as a live check (`LIVE-VERIFIED` or `NOT VERIFIED`) | operator |
| 6 | Human gate `HG-…` attesting 3-5; its id goes into `KNOWLEDGE_S3_ATTESTATION` | owner |
**Until all six are done:** production uploads, ingestion, detection and component analysis stay off; no flag, test or document may say otherwise. The sandbox work (SCR-K-05) changes none of these gates.

## D-45 — foreign-source parsing without running its SDK (approach DECIDED, grammar not yet bundled)
**Decided (owner, 2026-11-20):** bundled tree-sitter parsers, no SDK execution.
(Correction: earlier S-K2c documents said D-45 was undecided; that was wrong.)
**Today:** Dart/Flutter is read by an interim lexical analyzer (regular Flutter declarations only; anything else is absent, nothing guessed).
**Still needed to finish D-45 (implementation gates, not product decisions):**
| # | Item | Why it is a gate |
|---|---|---|
| 1 | Choose the Dart grammar (candidate: `tree-sitter-dart`) and read its licence | supply-chain and licence compatibility with the platform |
| 2 | Pin an exact version and record the hash of the built WASM; build it reproducibly in the repository, never download at run time | provenance, offline determinism |
| 3 | Add the `web-tree-sitter` runtime the same way (pinned, vetted) | a new dependency in the worker |
| 4 | Run it inside the parser sandbox (SCR-K-05) with the same limits | the isolation this slice built |
| 5 | Golden tests comparing it with the lexical analyzer on the sample Flutter packages; lexical analyzer kept as fallback behind the same flag | no regression |
These steps add a dependency and a binary artifact, so they need the owner's explicit go-ahead (dependency review) before they start. They are part of S-K4's Flutter work in `AUDIT_AND_PLAN.md`.

## Rules that stay in force
No production credential, bucket, provider call or live check is created or run by an agent (CLAUDE.md §5). BLOCKED stays BLOCKED: mocks and fakes never turn D-42 into PASS. Flags default off.
