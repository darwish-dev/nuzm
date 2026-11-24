#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { executionGateway as eg } from '@nuzm/domain';
import { createEgressProxy } from './egress-proxy';
import { Metrics } from './metrics';
import { createMetricsServer } from './server';

/**
 * `nuzm-egress-proxy --config /etc/nuzm/proxy.json`  { "listen": {"host":"10.200.0.1","port":3128}, "metrics": {"port":9101}, "allowHosts": ["registry.npmjs.org", ...] }
 * The listen address is the dummy-interface address sandboxes route to (`network.ts`); it is never a wildcard. The allow-list is the dependency policy's registry hosts.
 */
export async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--config');
  const file = i >= 0 ? argv[i + 1] : undefined;
  if (!file) {
    console.error('usage: nuzm-egress-proxy --config <file>');
    return 2;
  }
  const c = JSON.parse(await readFile(file, 'utf8')) as { listen?: { host?: string; port?: number }; metrics?: { port?: number }; allowHosts?: string[] };
  if (!c.listen?.host || ['0.0.0.0', '::', '*'].includes(c.listen.host) || !c.listen.port) {
    console.error('REFUSED: listen address missing or a wildcard');
    return 2;
  }
  if (!Array.isArray(c.allowHosts) || c.allowHosts.length === 0 || !c.allowHosts.every((h) => eg.isAllowableEgressHost(h))) {
    console.error('REFUSED: allowHosts missing or invalid');
    return 2;
  }
  const metrics = new Metrics();
  const proxy = createEgressProxy({ allowHosts: c.allowHosts, metrics, onEvent: (e) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...e })) });
  await new Promise<void>((r) => proxy.listen(c.listen!.port!, c.listen!.host!, r));
  const ms = createMetricsServer(metrics);
  await new Promise<void>((r) => ms.listen(c.metrics?.port ?? 9101, '127.0.0.1', r));
  return new Promise<number>((resolve) => {
    const stop = () => {
      proxy.close();
      ms.close();
      resolve(0);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}
if (require.main === module) void main(process.argv.slice(2)).then((c) => process.exit(c));
