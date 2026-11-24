import type { BinaryAllowList } from './command-runner';

/**
 * Network plan for ONE sandbox. Pure: it returns argv arrays and a namespace name; the launcher runs them through the `CommandRunner`.
 *
 *  - class `none`   no pre-wired namespace at all. `runsc` is started with `--network=none`; the sandbox has a loopback and nothing else.
 *  - class `registry-only`  a dedicated network namespace `nz-<slot>` joined to the host by a veth pair on its own /30 (`10.201.<slot>.0/30`). The sandbox reaches exactly ONE
 *    thing: the egress proxy's address on the node (`proxyAddr`, a dummy-interface address in `10.200.0.0/24`), via a host route over that veth. There is no default route, no
 *    DNS server and no forwarding: the node's STATIC firewall (`infra/runtime/nftables/nuzm-node.nft`, loaded once by the bootstrap) accepts `iifname "vh-*"` traffic to the proxy address and port
 *    ONLY and drops the rest, in both input and forward; there are no per-sandbox firewall rules to leak or forget. Name resolution happens inside the proxy (the sandbox sends `CONNECT registry.npmjs.org:443`), so a sandbox never resolves a name itself.
 *
 * Slots are small integers handed out by the launcher (1..maxSlots) so names and subnets are unique per concurrently running sandbox and reused only after teardown.
 */
export interface NetworkPlan {
  setup: string[][];
  teardown: string[][];
  netnsName: string | null;
  /** `/var/run/netns/<name>` for the OCI network namespace path */
  netnsPath: string | null;
  runscNetwork: 'none' | 'sandbox';
}
export function planNetwork(
  slot: number,
  klass: 'none' | 'registry-only',
  proxyAddr: string,
  bin: Pick<BinaryAllowList, 'ip'>,
): NetworkPlan {
  if (!Number.isInteger(slot) || slot < 1 || slot > 250) throw new Error('slot_out_of_range');
  if (klass === 'none')
    return { setup: [], teardown: [], netnsName: null, netnsPath: null, runscNetwork: 'none' };
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/.exec(proxyAddr);
  if (!m) throw new Error('proxy_addr_invalid');
  const [, proxyIp] = m;
  const ns = `nz-${slot}`;
  const host = `vh-${slot}`;
  const peer = `vc-${slot}`;
  const hostIp = `10.201.${slot}.1`;
  const peerIp = `10.201.${slot}.2`;
  const ip = bin.ip;
  const setup: string[][] = [
    [ip, 'netns', 'add', ns],
    [ip, 'link', 'add', host, 'type', 'veth', 'peer', 'name', peer],
    [ip, 'link', 'set', peer, 'netns', ns],
    [ip, 'addr', 'add', `${hostIp}/30`, 'dev', host],
    [ip, 'link', 'set', host, 'up'],
    [ip, '-n', ns, 'addr', 'add', `${peerIp}/30`, 'dev', peer],
    [ip, '-n', ns, 'link', 'set', peer, 'up'],
    [ip, '-n', ns, 'link', 'set', 'lo', 'up'],
    // the ONE route inside the sandbox's namespace: the proxy host address, via the host end of the veth
    [ip, '-n', ns, 'route', 'add', `${proxyIp}/32`, 'via', hostIp, 'dev', peer],
  ];
  const teardown: string[][] = [
    // removing the host end removes the pair; deleting the namespace removes anything left inside it
    [ip, 'link', 'del', host],
    [ip, 'netns', 'del', ns],
  ];
  return {
    setup,
    teardown,
    netnsName: ns,
    netnsPath: `/var/run/netns/${ns}`,
    runscNetwork: 'sandbox',
  };
}
