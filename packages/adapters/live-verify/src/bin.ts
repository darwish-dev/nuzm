#!/usr/bin/env node
import { Redactor } from '@nuzm/adapter-contracts';
import { AlibabaEcsAdapter } from '@nuzm/adapter-alibaba-ecs';
import { ContaboVpsAdapter } from '@nuzm/adapter-contabo-vps';
import { HuaweiEcsAdapter } from '@nuzm/adapter-huawei-ecs';
import { createFetchTransport } from '@nuzm/adapter-http';
import { FileVaultClient } from '@nuzm/adapter-runtime';
import { runCli } from './cli';

/**
 * Owner entry point: `node dist/bin.js` (see spec/providers/live-verify.yaml and docs/runbooks/live-verification.md). Uses the non-production file
 * vault stub (NUZM_DEV_VAULT_FILE) — a dedicated TEST account only; the production vault is BLOCKED on D-12 and the stub refuses NODE_ENV=production.
 * Networking per region for Alibaba/Huawei comes from NUZM_LV_NETWORK_JSON ({"<region>": {...}}).
 */
const HOSTS = {
  alibaba: ['*.aliyuncs.com'],
  huawei: ['*.myhuaweicloud.com'],
  contabo: ['api.contabo.com', 'auth.contabo.com'],
} as const;

void runCli(process.env, {
  log: (l) => console.log(l),
  async makeAdapter(provider, env) {
    const path = env.NUZM_DEV_VAULT_FILE;
    if (!path)
      throw new Error(
        'NUZM_DEV_VAULT_FILE is required (dedicated test account, non-production vault stub)',
      );
    const redactor = new Redactor();
    const vault = new FileVaultClient({ path, redactor });
    const key = provider as keyof typeof HOSTS;
    const transport = createFetchTransport({
      policy: { adapterId: `${provider}-lv`, hosts: HOSTS[key] },
    });
    const net = env.NUZM_LV_NETWORK_JSON
      ? (JSON.parse(env.NUZM_LV_NETWORK_JSON) as Record<string, never>)
      : {};
    if (key === 'alibaba')
      return new AlibabaEcsAdapter({ vault, redactor, transport, network: (r) => net[r] });
    if (key === 'huawei')
      return new HuaweiEcsAdapter({ vault, redactor, transport, network: (r) => net[r] });
    return new ContaboVpsAdapter({ vault, redactor, transport });
  },
}).then((r) => process.exit(r.exitCode));
