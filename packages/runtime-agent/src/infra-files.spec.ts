import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executionGateway as eg } from '@nuzm/domain';
import { parseAgentConfig } from './config';

const root = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('reviewed infrastructure artifacts cannot run as shipped', () => {
  it('the example agent config is REFUSED by the real parser until an operator fills it (placeholders never start an agent)', () => {
    const r = parseAgentConfig(JSON.parse(read('infra/runtime/agent/agent.example.json')));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.join(',')).toMatch(
        /tls_client_fingerprints_required|trusted_control_key_invalid|image_entry_invalid/,
      );
  });
  it('the Android definition is REFUSED by its validator until pins and a named licence acceptor exist', () => {
    const def = JSON.parse(
      read('infra/runtime/profiles/android/android-build-env.json'),
    ) as eg.AndroidBuildEnv;
    const v = eg.validateAndroidBuildEnv(def);
    expect(v).toEqual(
      expect.arrayContaining([
        'toolchain_jdk_not_pinned',
        'toolchain_androidSdk_not_pinned',
        'toolchain_flutter_not_pinned',
        'toolchain_gradle_not_pinned',
        'android_licence_not_accepted_by_a_named_human',
      ]),
    );
    expect(v).not.toContain('network_not_mirror_only');
    expect(v).not.toContain('production_keys_allowed');
  });
  it('the static firewall: default-deny in all three chains, nothing forwarded, the proxy as the only thing a sandbox can reach, metadata dropped', () => {
    const f = read('infra/runtime/nftables/nuzm-node.nft');
    for (const c of ['input', 'forward', 'output'])
      expect(
        new RegExp(`chain ${c} \\{\\s*type filter hook ${c} priority 0; policy drop;`).test(f),
        c,
      ).toBe(true);
    expect(f).toMatch(
      /iifname "vh-\*" ip daddr \$\{PROXY_IP\} tcp dport \$\{PROXY_PORT\} accept\s*\n\s*iifname "vh-\*" drop/,
    );
    expect(f).toContain('169.254.0.0/16 drop');
    expect(f).not.toMatch(/chain forward \{[^}]*accept/);
  });
  it('the rootfs recipe forbids a package manager, a compiler, network clients and git, and a lockfile-only, script-free install', () => {
    const r = JSON.parse(read('infra/runtime/rootfs/recipe.json')) as {
      base: { forbidden: string[] };
      dependencyPolicy: { lifecycleScripts: string };
    };
    for (const p of ['apt', 'gcc', 'curl', 'wget', 'git', 'ssh', 'python3'])
      expect(r.base.forbidden).toContain(p);
    expect(r.dependencyPolicy.lifecycleScripts).toMatch(/ignore-scripts=true/);
    expect(read('infra/runtime/rootfs/npmrc')).toMatch(/^ignore-scripts=true$/m);
  });
  it('the agent unit does not listen on a wildcard and the proxy unit drops every capability', () => {
    expect(read('infra/runtime/systemd/nuzm-egress-proxy.service')).toMatch(
      /CapabilityBoundingSet=\s*\n/,
    );
    expect(read('infra/runtime/systemd/nuzm-egress-proxy.service')).toContain('User=nuzm-proxy');
    expect(read('infra/runtime/proxy/proxy.example.json')).not.toMatch(/0\.0\.0\.0/);
  });
  it('the same registry host appears in the proxy, the agent example and the control-plane policy', () => {
    const host = eg.registryHosts()[0]!;
    expect(read('infra/runtime/proxy/proxy.example.json')).toContain(host);
    expect(read('infra/runtime/agent/agent.example.json')).toContain(host);
  });
});
