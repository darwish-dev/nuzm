/** What the install needs from the hosting side and from DNS. Cloud never touches hosting tables: hosting implements `PanelNodePort` behind its public surface. */
export interface PanelNodePort {
  /** Idempotent per compute instance: registers the customer's VPS as a node of class `customer_vps` (outside the shared network) with its panel connection. */
  registerNode(req: {
    orgId: string;
    instanceId: string;
    name: string;
    region: string;
    dataRegion: string;
    panelHost: string;
    panelPort: number;
    tlsPinSha256: string | null;
    keyRef: string;
    panelVersion: string | null;
  }): Promise<{ nodeId: string }>;
  /** The server is gone: the node leaves service for good (status `retired`); nothing of the customer's is touched. */
  retire(nodeId: string): Promise<void>;
  /** A read-only look through the panel's REST API: health, version, and whether the key's profile is as narrow as intended. */
  check(nodeId: string): Promise<{
    health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
    panelVersion: string | null;
    profile: 'read_only' | 'too_broad' | 'unknown';
    code?: string;
  }>;
}

export type DnsResult = { ok: true } | { ok: false; code: string };
/** The panel's name must resolve to the server before Nuzm can reach it by FQDN. Which zone and which DNS provider is an owner decision (D-xx): until then no implementation is configured. */
export interface PanelDnsPort {
  ensureARecords(host: string, addresses: string[]): Promise<DnsResult>;
}
export class UnconfiguredPanelDns implements PanelDnsPort {
  async ensureARecords(): Promise<DnsResult> {
    return { ok: false, code: 'panel_dns_not_configured' };
  }
}
