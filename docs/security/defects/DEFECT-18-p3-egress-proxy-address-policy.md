# DEFECT-18: the P3-S02 egress proxy accepts addresses the Phase 2 classifier refuses

Found by: P3-S08 (independent review), 2026-11-24 · Component: `packages/runtime-agent/src/egress-proxy.ts` (`isPublicAddress`), P3-S02 branch `claude/p3-s02-runtime-999326` at `fe83787d` · Severity: **Low** (defence in depth) · Owner (fixer): P3-S02 · State: **OPEN**

## What is wrong
The proxy of the `registry-only` network class vets every address a resolver returns with its own function `isPublicAddress` before it connects. That function re-implements the address policy instead of reusing `isBlockedAddress` (`packages/domain/src/ai/ssrf.ts`), which already absorbed DEFECT-2 and DEFECT-3 in Phase 2. The two disagree on four spellings the proxy treats as public:

| Address | What it is | Phase 2 classifier | Proxy |
|---|---|---|---|
| `100::1`, `100::ffff` | `100::/64` discard-only prefix (the DEFECT-3 class) | blocked | **allowed** |
| `::7f00:1` | IPv4-compatible spelling of `127.0.0.1` (`::a.b.c.d`) | blocked | **allowed** |
| `fec0::1` | deprecated site-local `fec0::/10` | blocked | **allowed** |

The other 30 addresses of the comparison corpus (RFC 1918, loopback, link-local and metadata, CGNAT, documentation, multicast, IPv4-mapped in both notations, NAT64, 6to4, plus ordinary public addresses) agree.

## Exposure (why Low)
The proxy only connects to a host on its exact allow-list (`registry.npmjs.org`-class names) and only to an address its own resolver returned. The defect matters only if the registry's DNS answers one of these addresses (a DNS compromise or a mis-configured resolver on the node). Then the "refuse anything non-public" control does not fire. No sandbox can choose the address. It is a last-control gap, not a reachable escape on its own.

## How it was found and proven (SIMULATED / offline: a pure function, no socket, no network)
1. Differential run of both functions over a 34-address corpus (the Phase 2 36-address corpus spellings plus new ones): four disagreements, listed above.
2. Proving test: `apps/api/src/qa/qa-p3-egress-proxy.spec.ts::DEFECT-18` (an `it.fails` while open). Proving run against the producer's source before the merge:
   `P3_S08_EGRESS_PROXY_MODULE=<p3-s02 worktree>/packages/runtime-agent/src/egress-proxy.ts pnpm --filter @nuzm/api exec vitest run src/qa/qa-p3-egress-proxy.spec.ts` -> **4 passed, 1 expected fail** (2026-11-24). The suite is skipped until `@nuzm/runtime-agent` exists in the tree and then runs in `pnpm test` as a gate.

## Fix and re-test
Replace `isPublicAddress` by `!isBlockedAddress(ip)` from `@nuzm/domain` (plus the proxy's own "must be an IP" check), or make the proxy's function delegate to it. After the fix the `it.fails` turns the run red; flip it to a plain `it`, record the fix commit in `DEFECT-REGISTER.md`.

## Related observation (not registered: not reproduced)
O-17: in `createEgressProxy`, a client that disconnects while the upstream connect is in flight leaves the upstream socket connected until its 60 s idle timeout (the `close` listener of the already-closed client is attached too late), holding one of the 32 tunnel slots. A sandbox could repeat this to starve other tenants' installs on a shared proxy. To be tested with an injected connector once the package is merged; it becomes a defect only if the test shows slots held after the client is gone.
