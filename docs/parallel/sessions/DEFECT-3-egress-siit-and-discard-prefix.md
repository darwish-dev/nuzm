# DEFECT-3 — sandbox egress policy misses the SIIT form `::ffff:0:a.b.c.d` and 100::/64

Reporter: Session 07 (QA) · Owner: Session 04 (`apps/api/src/modules/appbuilder/internal/sandbox/egress.ts`) · Severity: **LOW** (defence in depth) · Status: FIXED, RE-TESTED (2026-11-24) · Found 2026-11-24, baseline `f81872d5`

## Where
`egress.ts:139` in `blockedV6`: `g.slice(0,5).every(x => x===0) && (g[5]===0xffff || g[5]===0)` handles `::ffff:a.b.c.d` (group 5) and `::a.b.c.d`, but the SIIT form `::ffff:0:a.b.c.d` carries `ffff` in group 4 and `0` in group 5.

## Reproduction
`classifyIpLiteral('::ffff:0:7f00:1')` → `{ literal:true, blocked:null, metadata:false }` (treated as public). Also `classifyIpLiteral('100::1')` (discard-only prefix 100::/64, RFC 6666) → public.

## Expected
Both blocked: SIIT embeds IPv4 `127.0.0.1`; 100::/64 is not a public destination.

## Suggested fix
Add `g.slice(0,4).every(x=>x===0) && g[4]===0xffff && g[5]===0` → `embedded(g[6],g[7])`; add `g[0]===0x100 && g[1]===0 && g[2]===0 && g[3]===0`.

## Tests
`apps/api/src/qa/qa-ssrf-egress.int.spec.ts` → `DEFECT-3` (2 `it.fails` cases). The other 14 embedded forms (compatible, 6to4, NAT64, mapped, Teredo, metadata) pass.

## Re-test result (2026-11-24, branch merged with integration/ai-engine 4af0920c)
FIXED and RE-TESTED: the 2 former `it.fails` cases are ordinary tests and pass.
