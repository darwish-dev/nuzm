# @nuzm/adapter-conformance

The conformance kit: `runComputeConformance(makeSubject)` returns a report (`liveStatus` is always `NOT VERIFIED`); `describeComputeConformance(testApi, name, makeSubject)` registers one test per case. Cases C01-C15 cover capability honesty, idempotent replay, timeout before/after the side effect with `findByToken`, delete idempotency, unsupported actions, error normalization, rate limiting, unsupported lookup, eventual consistency, canary redaction and token determinism. See [../README.md](../README.md).
