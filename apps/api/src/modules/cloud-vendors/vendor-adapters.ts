import type { Redactor, VaultClient } from '@nuzm/adapter-contracts';
import { AlibabaEcsAdapter, type AlibabaNetwork } from '@nuzm/adapter-alibaba-ecs';
import { ContaboVpsAdapter } from '@nuzm/adapter-contabo-vps';
import { HuaweiEcsAdapter, type HuaweiNetwork } from '@nuzm/adapter-huawei-ecs';
import { createFetchTransport, type HttpTransport } from '@nuzm/adapter-http';
import type { AdapterEntry } from '../cloud';
import type { NetworkSettingsService } from './network-settings.service';

/**
 * Real vendor adapters (M05 S18-S22), registered in the cloud module's AdapterRegistry at bootstrap. Each is built ONLY from the vendor's
 * official documentation and is NOT VERIFIED: no credential or account exists (HG-05-01/02/03 PENDING), so nothing here has ever called a vendor.
 *
 * Egress allow-lists mirror `spec/providers/providers.yaml` (a unit test keeps them equal); the guard refuses anything else.
 * Non-secret per-account settings (VPC networking per region, owner-recorded project ids) come from the `CLOUD_VENDOR_CONFIG` environment JSON
 * until an account-settings API exists (open item). Credentials are NEVER configuration: adapters resolve `vault://` references.
 */
export const VENDOR_EGRESS = {
  'alibaba-ecs': ['*.aliyuncs.com'],
  'huawei-ecs': ['*.myhuaweicloud.com'],
  'contabo-vps': ['api.contabo.com', 'auth.contabo.com'],
} as const;

export interface VendorConfig {
  alibaba?: { network?: Record<string, AlibabaNetwork> };
  huawei?: { network?: Record<string, HuaweiNetwork>; projectIds?: Record<string, string> };
}

export function parseVendorConfig(
  raw: string | undefined,
  warn: (m: string) => void = () => {},
): VendorConfig {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as VendorConfig;
  } catch {
    /* fall through */
  }
  warn('CLOUD_VENDOR_CONFIG is not a JSON object: ignored');
  return {};
}

export function vendorEntries(o: {
  vault: VaultClient;
  redactor: Redactor;
  config?: VendorConfig;
  /** Console-typed network settings (take precedence over `CLOUD_VENDOR_CONFIG`, which stays as a fallback). */
  network?: NetworkSettingsService;
  /** Tests inject a loopback transport; production always uses the egress-guarded fetch transport. */
  transport?: (adapterId: keyof typeof VENDOR_EGRESS) => HttpTransport;
}): AdapterEntry[] {
  const tp = (id: keyof typeof VENDOR_EGRESS): HttpTransport =>
    o.transport?.(id) ??
    createFetchTransport({ policy: { adapterId: id, hosts: VENDOR_EGRESS[id] } });
  const cfg = o.config ?? {};
  const alibabaNet = (r: string): AlibabaNetwork | undefined => {
    const n = o.network?.get('alibaba', r);
    return n?.vSwitchId && n.securityGroupId
      ? {
          vSwitchId: n.vSwitchId,
          securityGroupId: n.securityGroupId,
          ...(n.zoneId ? { zoneId: n.zoneId } : {}),
        }
      : cfg.alibaba?.network?.[r];
  };
  const huaweiNet = (r: string): HuaweiNetwork | undefined => {
    const n = o.network?.get('huawei', r);
    return n?.vpcId && n.subnetId && n.securityGroupId
      ? {
          vpcId: n.vpcId,
          subnetId: n.subnetId,
          securityGroupId: n.securityGroupId,
          ...(n.availabilityZone ? { availabilityZone: n.availabilityZone } : {}),
        }
      : cfg.huawei?.network?.[r];
  };
  // the adapter indexes `projectIds[region]`: a live view over the console settings, then the environment fallback
  const huaweiProjects = new Proxy({} as Record<string, string>, {
    get: (_t, region) =>
      typeof region === 'string'
        ? (o.network?.get('huawei', region)?.projectId ?? cfg.huawei?.projectIds?.[region])
        : undefined,
  });
  return [
    {
      adapterId: 'alibaba-ecs',
      nonProductionOnly: false,
      requiresCredentials: true,
      egress: { adapterId: 'alibaba-ecs', hosts: VENDOR_EGRESS['alibaba-ecs'] },
      create: () =>
        new AlibabaEcsAdapter({
          vault: o.vault,
          redactor: o.redactor,
          transport: tp('alibaba-ecs'),
          network: alibabaNet,
        }),
    },
    {
      adapterId: 'huawei-ecs',
      nonProductionOnly: false,
      requiresCredentials: true,
      egress: { adapterId: 'huawei-ecs', hosts: VENDOR_EGRESS['huawei-ecs'] },
      create: () =>
        new HuaweiEcsAdapter({
          vault: o.vault,
          redactor: o.redactor,
          transport: tp('huawei-ecs'),
          network: huaweiNet,
          projectIds: huaweiProjects,
        }),
    },
    {
      adapterId: 'contabo-vps',
      nonProductionOnly: false,
      requiresCredentials: true,
      egress: { adapterId: 'contabo-vps', hosts: VENDOR_EGRESS['contabo-vps'] },
      create: () =>
        new ContaboVpsAdapter({
          vault: o.vault,
          redactor: o.redactor,
          transport: tp('contabo-vps'),
        }),
    },
  ];
}
