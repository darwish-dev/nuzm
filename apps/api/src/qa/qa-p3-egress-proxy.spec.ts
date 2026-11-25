import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isBlockedAddress } from '@nuzm/domain';

/**
 * P3-S08, security negatives for the P3-S02 EGRESS PROXY address policy (`packages/runtime-agent/src/egress-proxy.ts`: `isPublicAddress`). Pure function, no network, no process.
 * The package is not part of the Phase 2 base: until P3-S02 is merged this suite is SKIPPED (the import below cannot resolve); from the merge on it runs and is a CI gate.
 *
 * DEFECT-18 (Low, defence in depth): the proxy re-implements the address policy instead of reusing the classifier that fixed DEFECT-2/3 (`isBlockedAddress` in
 * `packages/domain/src/ai/ssrf.ts`), and it misses `100::/64` (discard-only prefix), `::a.b.c.d` / `::7f00:1` (IPv4-compatible) and `fec0::/10` (site-local). It is only reachable
 * if an allow-listed host's DNS answers such an address, which is why it is Low; the same class was Medium-Low in Phase 2 because the policy is the last control before the connect.
 * The secure expectation was an `it.fails` while the defect was open (the Phase 2 convention); it was flipped to a plain `it` after P3-S02's fix `074ef411` (re-run: 5 passed against that source).
 */
// P3_S08_EGRESS_PROXY_MODULE lets the independent verifier point the suite at a branch's source before the merge (the proving run recorded in DEFECT-18)
const override = process.env.P3_S08_EGRESS_PROXY_MODULE;
const spec = override ?? '@nuzm/runtime-agent';
// available = the override file exists, or the package is in this tree (no top-level await: this file is a CommonJS module)
const available = override
  ? existsSync(override)
  : existsSync(join(process.cwd(), '../../packages/runtime-agent/package.json'));
let proxy: ((ip: string) => boolean) | undefined;
beforeAll(async () => {
  if (!available) return;
  const mod = (await import(/* @vite-ignore */ spec)) as {
    isPublicAddress: (ip: string) => boolean;
  };
  proxy = mod.isPublicAddress;
});

/** addresses the Phase 2 classifier refuses and the proxy MUST therefore refuse */
const MUST_REFUSE = [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.1.1',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.1',
  '224.0.0.1',
  '255.255.255.255',
  '198.18.0.1',
  '192.0.2.1',
  '::',
  '::1',
  'fe80::1',
  'fc00::1',
  'fd00::1',
  'ff02::1',
  '2001:db8::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:0:7f00:1',
  '64:ff9b::7f00:1',
  '2002:7f00:1::1',
];
const OPEN_DEFECT_18 = ['100::1', '100::ffff', '::7f00:1', 'fec0::1'];
const MUST_ALLOW = ['8.8.8.8', '1.1.1.1', '104.16.0.1', '2606:4700::1111', '2a00:1450:4001::1'];

describe.skipIf(!available)(
  'P3-S02 egress proxy: address policy (skipped until the package is merged)',
  () => {
    it('the corpus is sane: the Phase 2 classifier refuses every MUST_REFUSE and DEFECT-18 address, and allows every MUST_ALLOW', () => {
      for (const a of [...MUST_REFUSE, ...OPEN_DEFECT_18])
        expect(isBlockedAddress(a), a).toBe(true);
      for (const a of MUST_ALLOW) expect(isBlockedAddress(a), a).toBe(false);
    });
    it('refuses private, loopback, link-local, metadata, CGNAT, documentation, multicast and mapped spellings', () => {
      for (const a of MUST_REFUSE) expect(proxy!(a), a).toBe(false);
    });
    it('allows ordinary public unicast addresses', () => {
      for (const a of MUST_ALLOW) expect(proxy!(a), a).toBe(true);
    });
    it('refuses what is not an IP address at all', () => {
      for (const a of [
        '',
        'localhost',
        'example.com',
        '1.2.3',
        '999.1.1.1',
        '1.1.1.1/8',
        ' 8.8.8.8',
      ])
        expect(proxy!(a), JSON.stringify(a)).toBe(false);
    });
    // DEFECT-18: fixed by P3-S02 (the proxy delegates to the shared classifier)
    it('DEFECT-18: refuses everything the Phase 2 classifier refuses (100::/64, IPv4-compatible ::a.b.c.d, site-local fec0::/10)', () => {
      for (const a of OPEN_DEFECT_18) expect(proxy!(a), a).toBe(false);
    });
  },
);
