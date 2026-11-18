import { randomUUID } from 'node:crypto';
import {
  startLocalServer,
  type LocalReply,
  type LocalRequest,
  type LocalServer,
} from '@nuzm/adapter-http';
import { CONTABO_PRODUCTS, CONTABO_REGION_ENUM, productById } from './products';

/**
 * Local simulator of the Contabo API, shaped ONLY from the official reference (https://api.contabo.com/, read 2026-11-18). It exists so the
 * adapter and the conformance kit can run offline. It proves nothing about the real service (every result is NOT VERIFIED).
 * Behaviours the docs do NOT state (idempotency, listing lag, status after cancel) are configurable here, never assumed by the adapter.
 */
export type SimFaultOp = 'provision' | 'inspect' | 'findByToken' | 'delete' | 'act';
export type SimFaultKind =
  'timeout_after_side_effect' | 'timeout_before_side_effect' | 'rate_limit' | 'outage';

interface SimInstance {
  instanceId: number;
  displayName: string;
  productId: string;
  region: string;
  imageId: string;
  status: string;
  createdDate: string;
  cancelDate: string | null;
  visibleAt: number;
  userData?: string;
  snapshots: { snapshotId: string; name: string }[];
}

export class ContaboSim {
  readonly instances = new Map<number, SimInstance>();
  readonly requests: { method: string; path: string }[] = [];
  private faults: { op: SimFaultOp; kind: SimFaultKind; left: number }[] = [];
  private seq = 100;
  private tokenSeq = 0;
  private lagMs = 0;
  private server: LocalServer | null = null;
  /** Data centres the simulated account lists (slug, region). */
  dataCenters = [
    {
      name: 'European Union 1',
      slug: 'EU1',
      regionName: 'European Union',
      regionSlug: 'EU',
      capabilities: ['VPS', 'Object-Storage'],
    },
    {
      name: 'United Kingdom 1',
      slug: 'UK1',
      regionName: 'United Kingdom',
      regionSlug: 'UK',
      capabilities: ['VPS'],
    },
  ];
  requireCredentials = {
    client_id: 'sim-client',
    client_secret: 'sim-client-secret-value',
    username: 'sim-user@example.invalid',
    password: 'sim-api-password-value',
  };

  constructor(private readonly now: () => number) {}

  get baseUrl(): string {
    return this.server!.baseUrl;
  }
  get tokenUrl(): string {
    return `${this.server!.baseUrl}/auth/realms/contabo/protocol/openid-connect/token`;
  }
  async start(): Promise<this> {
    this.server = await startLocalServer((r) => this.handle(r));
    return this;
  }
  async stop(): Promise<void> {
    await this.server?.close();
  }

  inject(op: SimFaultOp, kind: SimFaultKind, times = 1): void {
    this.faults.push({ op, kind, left: times });
  }
  setConsistencyLag(ms: number): void {
    this.lagMs = ms;
  }
  billableCount(): number {
    return [...this.instances.values()].filter((i) => !this.ended(i)).length;
  }
  billableByToken(token: string): number {
    return [...this.instances.values()].filter(
      (i) => !this.ended(i) && i.displayName.startsWith(`nuzm:${token}|`),
    ).length;
  }
  private ended(i: SimInstance): boolean {
    return i.cancelDate !== null && Date.parse(i.cancelDate) <= this.now();
  }

  private take(op: SimFaultOp): SimFaultKind | null {
    const f = this.faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left -= 1;
    return f.kind;
  }
  private page(items: unknown[], q: URLSearchParams, selfPath: string) {
    const size = Math.max(1, Number(q.get('size') ?? 10));
    const page = Math.max(1, Number(q.get('page') ?? 1));
    const totalPages = Math.max(1, Math.ceil(items.length / size));
    return {
      _pagination: { size, totalElements: items.length, totalPages, page },
      data: items.slice((page - 1) * size, page * size),
      _links: { self: `${selfPath}?page=${page}` },
    };
  }
  private json(status: number, body: unknown): LocalReply {
    return { status, body: JSON.stringify(body) };
  }
  private instanceView(i: SimInstance) {
    return {
      tenantId: 'DE',
      customerId: 'sim-customer',
      instanceId: i.instanceId,
      name: `vmd${i.instanceId}`,
      displayName: i.displayName,
      region: i.region,
      productId: i.productId,
      imageId: i.imageId,
      ipConfig: {
        v4: { ip: `192.0.2.${(i.instanceId % 250) + 1}`, netmaskCidr: 24, gateway: '192.0.2.1' },
      }, // TEST-NET-1
      osType: 'Linux',
      createdDate: i.createdDate,
      ...(i.cancelDate ? { cancelDate: i.cancelDate } : {}),
      status: i.status,
    };
  }
  private visible(i: SimInstance): boolean {
    return i.visibleAt <= this.now();
  }

  private async handle(r: LocalRequest): Promise<LocalReply> {
    this.requests.push({ method: r.method, path: r.path });
    if (r.path === '/auth/realms/contabo/protocol/openid-connect/token') {
      const f = new URLSearchParams(r.body);
      const c = this.requireCredentials;
      if (
        f.get('grant_type') !== 'password' ||
        f.get('client_id') !== c.client_id ||
        f.get('client_secret') !== c.client_secret ||
        f.get('username') !== c.username ||
        f.get('password') !== c.password
      )
        return this.json(401, { error: 'invalid_grant' });
      return this.json(200, {
        access_token: `sim-access-token-${++this.tokenSeq}-${randomUUID()}`,
      });
    }
    const auth = String(r.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer sim-access-token-'))
      return this.json(401, { message: 'no valid credentials' });
    const rid = String(r.headers['x-request-id'] ?? '');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rid))
      return this.json(400, { message: 'x-request-id must be a UUIDv4' });

    const p = r.path;
    if (p === '/v1/data-centers' && r.method === 'GET')
      return this.json(200, this.page(this.dataCenters, r.query, p));
    if (p === '/v1/compute/images' && r.method === 'GET')
      return this.json(
        200,
        this.page(
          [
            {
              imageId: 'afecbb85-e2fc-46f0-9684-b46b1faf00bb',
              name: 'ubuntu-22.04',
              osType: 'Linux',
              standardImage: true,
            },
          ],
          r.query,
          p,
        ),
      );

    if (p === '/v1/compute/instances' && r.method === 'GET') {
      const search = r.query.get('search');
      const fk = search?.startsWith('nuzm:') ? this.take('findByToken') : this.take('inspect');
      const gate = this.gate(fk);
      if (gate) return gate;
      let items = [...this.instances.values()].filter((i) => this.visible(i));
      if (search) items = items.filter((i) => i.displayName.includes(search));
      return this.json(
        200,
        this.page(
          items.map((i) => this.instanceView(i)),
          r.query,
          p,
        ),
      );
    }
    if (p === '/v1/compute/instances' && r.method === 'POST') {
      const fault = this.take('provision');
      const gate = this.gate(fault);
      if (gate) return gate;
      const b = JSON.parse(r.body || '{}') as Record<string, unknown>;
      const productId = String(b.productId ?? 'V153');
      const region = String(b.region ?? 'EU');
      if (
        !productById(productId) ||
        !(CONTABO_REGION_ENUM as readonly string[]).includes(region) ||
        b.period === undefined
      )
        return this.json(400, { message: 'malformed create request' });
      if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
      const i: SimInstance = {
        instanceId: ++this.seq,
        displayName: String(b.displayName ?? ''),
        productId,
        region,
        imageId: String(b.imageId ?? 'afecbb85-e2fc-46f0-9684-b46b1faf00bb'),
        status: 'running', // the docs' 201 sample shows `running`
        createdDate: new Date(this.now()).toISOString(),
        cancelDate: null,
        visibleAt: this.now() + this.lagMs,
        ...(typeof b.userData === 'string' ? { userData: b.userData } : {}),
        snapshots: [],
      };
      this.instances.set(i.instanceId, i);
      if (fault === 'timeout_after_side_effect') return { status: 201, hang: true };
      return this.json(201, {
        data: [
          {
            tenantId: 'DE',
            customerId: 'sim-customer',
            instanceId: i.instanceId,
            createdDate: i.createdDate,
            imageId: i.imageId,
            productId,
            region,
            status: i.status,
          },
        ],
        _links: { self: `/v1/compute/instances/${i.instanceId}` },
      });
    }
    const m = /^\/v1\/compute\/instances\/(\d+)(\/.*)?$/.exec(p);
    if (m) {
      const inst = this.instances.get(Number(m[1]));
      const sub = m[2] ?? '';
      if (sub === '' && r.method === 'GET') {
        const gate = this.gate(this.take('inspect'));
        if (gate) return gate;
        if (!inst || !this.visible(inst)) return this.json(404, { message: 'not found' });
        return this.json(200, { data: [this.instanceView(inst)], _links: { self: p } });
      }
      if (sub === '/cancel' && r.method === 'POST') {
        const fault = this.take('delete');
        const gate = this.gate(fault);
        if (gate) return gate;
        if (!inst) return this.json(404, { message: 'not found' });
        if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
        const cd = String((JSON.parse(r.body || '{}') as { cancelDate?: string }).cancelDate ?? '');
        if (Number.isNaN(Date.parse(cd))) return this.json(400, { message: 'cancelDate required' });
        inst.cancelDate = cd;
        if (fault === 'timeout_after_side_effect') return { status: 201, hang: true };
        return this.json(201, {
          data: [
            {
              tenantId: 'DE',
              customerId: 'sim-customer',
              instanceId: inst.instanceId,
              cancelDate: cd,
            },
          ],
          _links: { self: p },
        });
      }
      const act = /^\/actions\/(start|stop|restart|shutdown)$/.exec(sub);
      if (act && r.method === 'POST') {
        const fault = this.take('act');
        const gate = this.gate(fault);
        if (gate) return gate;
        if (!inst) return this.json(404, { message: 'not found' });
        if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
        inst.status = act[1] === 'stop' || act[1] === 'shutdown' ? 'stopped' : 'running';
        if (fault === 'timeout_after_side_effect') return { status: 201, hang: true };
        return this.json(201, {
          data: [
            {
              tenantId: 'DE',
              customerId: 'sim-customer',
              instanceId: inst.instanceId,
              action: act[1],
            },
          ],
          _links: { self: p },
        });
      }
      if (sub === '/snapshots' && r.method === 'POST') {
        const gate = this.gate(this.take('act'));
        if (gate) return gate;
        if (!inst) return this.json(404, { message: 'not found' });
        const b = JSON.parse(r.body || '{}') as { name?: string };
        if (!b.name || b.name.length > 30)
          return this.json(400, { message: 'invalid snapshot name' });
        const s = { snapshotId: `snap${this.now()}`, name: b.name };
        inst.snapshots.push(s);
        return this.json(201, {
          data: [
            {
              tenantId: 'DE',
              customerId: 'sim-customer',
              snapshotId: s.snapshotId,
              name: s.name,
              instanceId: inst.instanceId,
            },
          ],
          _links: { self: `${p}/${s.snapshotId}` },
        });
      }
    }
    return this.json(404, { message: `no such endpoint ${r.method} ${p}` });
  }

  private gate(kind: SimFaultKind | null): LocalReply | null {
    if (kind === 'rate_limit') return this.json(429, { message: 'Rate-limit reached' });
    if (kind === 'outage') return this.json(503, { message: 'unavailable' });
    return null;
  }
}

export const CONTABO_SIM_PRODUCT_IDS = CONTABO_PRODUCTS.map((p) => p.productId);
