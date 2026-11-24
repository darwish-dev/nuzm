# DEFECT-2 — customer URL fetcher does not block IPv6 spellings of private IPv4 addresses

Reporter: Session 07 (QA) · Owner: **Session 02** (`apps/api/src/modules/ai/**` consumes it) / the file is `packages/domain/src/ai/ssrf.ts` (domain; no session row owns it → route through the Master) · Severity: **LOW-MEDIUM** (defence in depth; exploit needs a route to the embedded IPv4, normally absent on Linux hosts) · Status: OPEN · Found 2026-11-24, baseline `f81872d5`

## Where
`packages/domain/src/ai/ssrf.ts:13-55` `isBlockedAddress` (used by `safeFetch`, i.e. every customer-supplied URL an AI run fetches: `url-fetcher.ts`).

## Reproduction (offline)
```ts
import { isBlockedAddress } from '@nuzm/domain';
['::7f00:1','::127.0.0.1','::a9fe:a9fe','2002:7f00:1::','2002:a9fe:a9fe::1','2002:0a00:0001::','::ffff:0:7f00:1','2001:0:4136:e378:8000:63bf:3fff:fdd2']
  .map(isBlockedAddress)   // -> all false (treated as public)
```
`::ffff:7f00:1` (IPv4-mapped) and `64:ff9b::/96` ARE blocked. The sandbox egress policy (`apps/api/src/modules/appbuilder/internal/sandbox/egress.ts` `blockedV6`) blocks all of the forms above except SIIT (see DEFECT-3): the two implementations disagree.

## Expected
A resolved address is refused when it embeds a non-public IPv4 in any standard IPv6 spelling (IPv4-compatible `::/96`, 6to4 `2002::/16`, SIIT, Teredo `2001::/32`), exactly as the sandbox policy does. One implementation of "non-public address" should serve both call sites.

## Actual
`isBlockedAddress` only recognises `::`, `::1`, `::ffff:` mapped, `fc00::/7`, `fe80::/10`, `ff00::/8`, and the prefixes `64:ff9b:`, `2001:db8:`, `fec0:`. An attacker who controls a DNS name can publish an AAAA record in one of the unlisted forms. The fetcher would connect to that address (the transport pins the vetted address).

## Severity reasoning
Linux does not route `::/96` or accept IPv4-compatible destinations, and 6to4/Teredo need a local tunnel interface, so no working exploit was found or tried (offline only). It becomes real on a host with a NAT64/6to4/SIIT translator. The fix is cheap and removes the divergence.

## Suggested fix
Reuse `classifyIpLiteral`/`blockedV6` from the sandbox egress module (move to `packages/domain`) in `isBlockedAddress`; keep `isBlockedAddress('') === true` (fail closed).

## Tests
`apps/api/src/qa/qa-ssrf-egress.int.spec.ts` → `DEFECT-2: customer URL fetcher blocks …` (8 `it.fails` cases) plus a differential test over a 36-address corpus where both implementations agree (they do for every canonical address).
