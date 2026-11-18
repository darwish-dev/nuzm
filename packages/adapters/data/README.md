# @nuzm/adapter-data (M08)

Data and email adapter contracts (docs/09 §5), their conformance suites, in-memory mock adapters and the `self-operated-database` orchestrator.

- `src/upstream.ts` — **mirror of the M05 S16 base types** (`@nuzm/adapter-contracts` v1.0.0). M08 was written before M05 was merged; when M05 is on the base, delete this file and re-export from `@nuzm/adapter-contracts` (see `docs/reports/M08-upstream-interface-assumptions.md`).
- `src/contracts/` — `DatabaseAdapter`, `CacheAdapter`, `ObjectStorageAdapter`, `TransactionalEmailAdapter`, `MailboxAdapter`, data capability ids.
- `src/conformance/` — one suite per kind. A pass says "our contract is honoured"; it NEVER says "the vendor works" (docs/09 §1 rule 6).
- `src/mock/` — deterministic simulators with fault injection. Evidence kind is always `mock`; results are `NOT VERIFIED (local reference)`.
- `src/self-operated/` — Nuzm-run PostgreSQL/MySQL/Redis via a compute port and a signed, allow-listed node agent (no arbitrary commands).
