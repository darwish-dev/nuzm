/* eslint-disable @typescript-eslint/no-explicit-any -- vendor JSON is untyped until narrowed */
import { createHash, randomUUID } from 'node:crypto';
import {
  startLocalServer,
  type LocalReply,
  type LocalRequest,
  type LocalServer,
} from '@nuzm/adapter-http';
import { signSdkHmacSha256 } from './signer';

/**
 * Local simulator of the Huawei Cloud ECS / IAM / IMS / EVS / CES / BSS APIs, shaped ONLY from the official documentation (see ../README.md
 * for the pages and the read date). It verifies the SDK-HMAC-SHA256 signature (or an IAM token) and answers the documented shapes.
 * It proves nothing about the real service: every result obtained through it is NOT VERIFIED. Behaviour the docs do not state (listing lag,
 * the status of a successful create, what delete does to a missing server) is configurable here, never assumed by the adapter.
 */
export type SimFaultOp = 'provision' | 'inspect' | 'findByToken' | 'delete' | 'act';
export type SimFaultKind =
  | 'timeout_after_side_effect'
  | 'timeout_before_side_effect'
  | 'rate_limit'
  | 'flow_limit_202' // Common.0024 is documented with HTTP 202
  | 'outage';

export interface SimServer {
  id: string;
  region: string;
  name: string;
  flavor: string;
  imageId: string;
  status: 'ACTIVE' | 'SHUTOFF' | 'BUILD' | 'ERROR';
  tags: Record<string, string>;
  visibleAt: number;
  deleted: boolean;
  clientToken?: string;
  ip: string;
  userData?: string;
}

const FLAVORS: {
  id: string;
  vcpus: string;
  ram: number;
  specs: Record<string, string>;
  price: number;
}[] = [
  {
    id: 's6.large.2',
    vcpus: '2',
    ram: 4096,
    specs: { 'cond:operation:status': 'normal' },
    price: 0.0585,
  },
  {
    id: 's6.xlarge.2',
    vcpus: '4',
    ram: 8192,
    specs: {
      'cond:operation:status': 'normal',
      'cond:operation:az': 'sim-az1(sellout), sim-az2(normal)',
    },
    price: 0.1172,
  },
  {
    id: 's6.2xlarge.2',
    vcpus: '8',
    ram: 16384,
    specs: { 'cond:operation:status': 'sellout' },
    price: 0.2344,
  },
  {
    id: 's6.4xlarge.2',
    vcpus: '16',
    ram: 32768,
    specs: { 'cond:operation:status': 'normal' },
    price: 0.4688,
  }, // beyond the catalog filter
  {
    id: 'old.flavor',
    vcpus: '1',
    ram: 1024,
    specs: { 'cond:operation:status': 'abandon' },
    price: 0.01,
  },
];
const VOLUME_PRICE_PER_GB_HOUR = 0.000307;
const pidOf = (region: string): string =>
  createHash('sha256').update(`pid|${region}`).digest('hex').slice(0, 32);

export class HuaweiSim {
  readonly servers = new Map<string, SimServer>();
  readonly calls: { method: string; path: string }[] = [];
  readonly credentials = {
    accessKey: 'SIMAKQTWAKYUCEXAMPLE1',
    secretKey: 'sim-secret-key-MFyfVmHc-0123456789',
    iamUser: 'sim-iam-user',
    iamPassword: 'sim-iam-password-value',
    domainName: 'sim-domain',
  };
  projects = [
    { name: 'ap-southeast-1', enabled: true },
    { name: 'me-east-1', enabled: true },
    { name: 'cn-north-4', enabled: true }, // no documented country in the adapter's table
    { name: 'ae-ad-1', enabled: false },
  ];
  bills: {
    cycle: string;
    res_instance_id: string;
    consume_amount: number;
    product_spec_desc: string;
  }[] = [];
  private faults: { op: SimFaultOp; kind: SimFaultKind; left: number }[] = [];
  private lagMs = 0;
  private server: LocalServer | null = null;
  private readonly byClientToken = new Map<string, { id: string; flavor: string; at: number }>();
  private readonly issued = new Set<string>();
  private readonly regionByPid = new Map<string, string>();
  private tokenSeq = 0;
  /** Seconds the simulated vendor keeps an X-Client-Token (the docs: eight hours). */
  clientTokenTtlMs = 8 * 3600_000;

  constructor(private readonly now: () => number) {
    for (const r of ['ap-southeast-1', 'me-east-1', 'cn-north-4', 'ae-ad-1'])
      this.regionByPid.set(pidOf(r), r);
    this.servers.set('11111111-2222-4333-8444-555555555555', {
      id: '11111111-2222-4333-8444-555555555555',
      region: 'ap-southeast-1',
      name: 'pre-existing',
      flavor: 's6.large.2',
      imageId: 'img',
      status: 'ACTIVE',
      tags: {},
      visibleAt: 0,
      deleted: false,
      ip: '198.51.100.7',
    });
  }
  get baseUrl(): string {
    return this.server!.baseUrl;
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
    return [...this.servers.values()].filter((s) => !s.deleted).length;
  }
  billableByToken(token: string): number {
    return [...this.servers.values()].filter((s) => !s.deleted && s.tags['nuzm-token'] === token)
      .length;
  }
  private take(op: SimFaultOp): SimFaultKind | null {
    const f = this.faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left -= 1;
    return f.kind;
  }
  private json(status: number, body: unknown, headers?: Record<string, string>): LocalReply {
    return { status, body: JSON.stringify(body), ...(headers ? { headers } : {}) };
  }
  private err(status: number, code: string, message: string): LocalReply {
    return this.json(status, { error: { code, message } });
  }
  private gate(kind: SimFaultKind | null): LocalReply | null {
    if (kind === 'rate_limit')
      return this.json(429, {
        error_code: 'APIGW.0308',
        error_msg: 'The throttling threshold has been reached',
      });
    if (kind === 'flow_limit_202')
      return this.json(202, { error: { code: 'Common.0024', message: 'Flow limit exceeded.' } });
    if (kind === 'outage')
      return this.err(500, 'Common.0001', 'A system exception occurred. Try again later.');
    return null;
  }
  private visible(s: SimServer): boolean {
    return !s.deleted && s.visibleAt <= this.now();
  }
  private view(s: SimServer) {
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      flavor: { id: s.flavor, name: s.flavor },
      image: { id: s.imageId },
      addresses: {
        'vpc-1': [
          { version: '4', addr: '192.168.0.10', 'OS-EXT-IPS:type': 'fixed' },
          { version: '4', addr: s.ip, 'OS-EXT-IPS:type': 'floating' },
        ],
      },
      tags: Object.entries(s.tags).map(([k, v]) => `${k}=${v}`),
      'OS-EXT-AZ:availability_zone': 'sim-az1',
      'os-extended-volumes:volumes_attached': [
        { id: `vol-${s.id}`, bootIndex: '0', device: '/dev/vda', delete_on_termination: 'false' },
      ],
    };
  }

  private verify(r: LocalRequest): LocalReply | null {
    const h = (n: string) => String(r.headers[n] ?? '');
    if (r.path === '/v3/auth/tokens') return null;
    const tok = h('x-auth-token');
    if (tok) return this.issued.has(tok) ? null : this.err(401, 'Common.0013', 'Invalid token.');
    const m = /^SDK-HMAC-SHA256 Access=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
      h('authorization'),
    );
    if (!m)
      return this.json(401, {
        error_code: 'APIGW.0301',
        error_msg: 'Incorrect IAM authentication information.',
      });
    if (m[1] !== this.credentials.accessKey)
      return this.json(401, {
        error_code: 'APIGW.0301',
        error_msg: 'Incorrect IAM authentication information.',
      });
    const d = h('x-sdk-date');
    const ms = Date.parse(
      d.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'),
    );
    if (!(Math.abs(ms - this.now()) <= 15 * 60_000))
      return this.json(401, {
        error_code: 'APIGW.0301',
        error_msg: 'The time difference exceeds 15 minutes.',
      });
    const q: Record<string, string> = {};
    r.query.forEach((v, k) => (q[k] = v));
    const again = signSdkHmacSha256({
      method: r.method,
      path: r.path,
      query: q,
      host: h('host'),
      body: r.body,
      date: d,
      accessKey: m[1]!,
      secretKey: this.credentials.secretKey,
      contentType: h('content-type'),
    });
    if (again.headers.authorization !== h('authorization'))
      return this.json(401, {
        error_code: 'APIGW.0301',
        error_msg: 'Incorrect IAM authentication information.',
      });
    return null;
  }

  private async handle(r: LocalRequest): Promise<LocalReply> {
    this.calls.push({ method: r.method, path: r.path });
    const bad = this.verify(r);
    if (bad) return bad;
    const p = r.path;
    const body = r.body ? (JSON.parse(r.body) as Record<string, any>) : {};

    if (p === '/v3/auth/tokens' && r.method === 'POST') {
      const u = body.auth?.identity?.password?.user;
      const c = this.credentials;
      if (
        u?.name !== c.iamUser ||
        u?.password !== c.iamPassword ||
        u?.domain?.name !== c.domainName
      )
        return this.json(401, {
          error: {
            code: 401,
            message: 'The username or password is wrong.',
            title: 'Unauthorized',
          },
        });
      const region = body.auth?.scope?.project?.name as string | undefined;
      if (region && !this.projects.some((x) => x.name === region && x.enabled))
        return this.json(401, {
          error: { code: 401, message: 'project not found', title: 'Unauthorized' },
        });
      const t = `sim-iam-token-${++this.tokenSeq}-${randomUUID()}`;
      this.issued.add(t);
      return this.json(
        201,
        {
          token: {
            project: region ? { id: pidOf(region), name: region } : undefined,
            methods: ['password'],
          },
        },
        { 'x-subject-token': t },
      );
    }
    if ((p === '/v3/projects' || p === '/v3/auth/projects') && r.method === 'GET') {
      const only = r.query.get('name');
      return this.json(200, {
        projects: this.projects
          .filter((x) => !only || x.name === only)
          .map((x) => ({
            name: x.name,
            id: pidOf(x.name),
            enabled: x.enabled,
            domain_id: 'sim-domain-id',
          })),
      });
    }
    if (p === '/v2/bills/ratings/on-demand-resources' && r.method === 'POST') {
      const res: Record<string, unknown>[] = [];
      for (const it of body.product_infos as Record<string, any>[]) {
        if (it.cloud_service_type === 'hws.service.type.ec2') {
          const fl = FLAVORS.find((f) => `${f.id}.linux` === it.resource_spec);
          if (fl)
            res.push({
              id: it.id,
              product_id: 'sim',
              amount: fl.price,
              discount_amount: 0,
              official_website_amount: fl.price,
              measure_id: 1,
            });
        } else if (it.cloud_service_type === 'hws.service.type.ebs')
          res.push({
            id: it.id,
            product_id: 'sim',
            amount: Math.round(Number(it.resource_size) * VOLUME_PRICE_PER_GB_HOUR * 1e6) / 1e6,
            measure_id: 1,
          });
      }
      return this.json(200, {
        amount: 0,
        currency: 'USD',
        measure_id: 1,
        product_rating_results: res,
      });
    }
    if (p === '/v2/bills/customer-bills/res-records/query' && r.method === 'POST') {
      const rows = this.bills.filter((b) => b.cycle === body.cycle);
      const off = Number(body.offset ?? 0);
      const lim = Number(body.limit ?? 10);
      return this.json(200, {
        monthly_records: rows
          .slice(off, off + lim)
          .map((b) => ({ ...b, cloud_service_type: 'hws.service.type.ec2' })),
        total_count: rows.length,
        currency: 'USD',
      });
    }

    const m = /^\/(v1|v1\.1|v2|V1\.0)\/([0-9a-f]{32})(\/.*)?$/.exec(p);
    if (p === '/v2/cloudimages' && r.method === 'GET')
      return this.json(200, {
        images: [
          {
            id: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
            name: 'Ubuntu 22.04 server 64bit',
            __os_type: 'Linux',
            status: 'active',
          },
        ],
        page_info: {},
      });
    if (!m) return this.err(404, 'Common.0014', `no such endpoint ${r.method} ${p}`);
    const region = this.regionByPid.get(m[2]!);
    if (!region)
      return this.err(
        403,
        'Common.0018',
        'The project ID in the URL is different from that in the token.',
      );
    const sub = m[3] ?? '';

    if (sub === '/cloudservers/flavors' && r.method === 'GET')
      return this.json(200, {
        flavors: FLAVORS.map((f) => ({
          id: f.id,
          name: f.id,
          vcpus: f.vcpus,
          ram: f.ram,
          disk: '0',
          os_extra_specs: f.specs,
        })),
      });
    if (sub === '/cloudservers/detail' && r.method === 'GET') {
      const tagged = !!r.query.get('name')?.startsWith('nz-');
      const gate = this.gate(this.take(tagged ? 'findByToken' : 'inspect'));
      if (gate) return gate;
      const name = r.query.get('name');
      const items = [...this.servers.values()].filter(
        (s) => this.visible(s) && s.region === region && (!name || s.name.includes(name)),
      );
      return this.json(200, { count: items.length, servers: items.map((s) => this.view(s)) });
    }
    if (sub === '/cloudservers' && r.method === 'POST' && m[1] === 'v1.1')
      return this.create(r, body, region);
    const one = /^\/cloudservers\/([0-9a-f-]{36})$/.exec(sub);
    if (one && r.method === 'GET') {
      const gate = this.gate(this.take('inspect'));
      if (gate) return gate;
      const s = this.servers.get(one[1]!);
      if (!s || !this.visible(s) || s.region !== region)
        return this.err(404, 'Ecs.0114', 'The ECS does not exist.');
      return this.json(200, { server: this.view(s) });
    }
    if (sub === '/cloudservers/action' && r.method === 'POST') {
      const fault = this.take('act');
      const gate = this.gate(fault);
      if (gate) return gate;
      const kind = Object.keys(body)[0] as 'os-start' | 'os-stop' | 'reboot';
      const s = this.servers.get(body[kind]?.servers?.[0]?.id);
      if (!s || s.deleted) return this.err(404, 'Ecs.0114', 'The ECS does not exist.');
      if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
      if (kind === 'os-start') s.status = 'ACTIVE';
      if (kind === 'os-stop') s.status = 'SHUTOFF';
      if (fault === 'timeout_after_side_effect') return { status: 200, hang: true };
      return this.json(200, { job_id: randomUUID().replace(/-/g, '') });
    }
    const rz = /^\/cloudservers\/([0-9a-f-]{36})\/resize$/.exec(sub);
    if (rz && r.method === 'POST') {
      const gate = this.gate(this.take('act'));
      if (gate) return gate;
      const s = this.servers.get(rz[1]!);
      if (!s || s.deleted) return this.err(404, 'Ecs.0114', 'The ECS does not exist.');
      if (s.status !== 'SHUTOFF') return this.err(400, 'Ecs.0005', 'the ECS must be stopped');
      s.flavor = String(body.resize?.flavorRef);
      return this.json(200, { job_id: randomUUID().replace(/-/g, '') });
    }
    if (sub === '/cloudservers/delete' && r.method === 'POST') {
      const fault = this.take('delete');
      const gate = this.gate(fault);
      if (gate) return gate;
      if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
      for (const x of (body.servers ?? []) as { id: string }[]) {
        const s = this.servers.get(x.id);
        if (s) s.deleted = true;
      }
      if (fault === 'timeout_after_side_effect') return { status: 200, hang: true };
      return this.json(200, { job_id: randomUUID().replace(/-/g, '') });
    }
    if (/^\/jobs\/[0-9a-f]{32}$/.test(sub) && r.method === 'GET')
      return this.json(200, {
        status: 'SUCCESS',
        job_id: sub.slice(6),
        job_type: 'deleteVMs',
        entities: {},
        error_code: null,
        fail_reason: null,
      });
    if (sub === '/cloudsnapshots' && r.method === 'POST') {
      const gate = this.gate(this.take('act'));
      if (gate) return gate;
      return this.json(202, {
        snapshot: {
          id: randomUUID(),
          status: 'creating',
          volume_id: body.snapshot?.volume_id,
          name: body.snapshot?.name,
        },
      });
    }
    if (sub === '/batch-query-metric-data' && r.method === 'POST') {
      const id = body.metrics?.[0]?.dimensions?.[0]?.value as string;
      const s = this.servers.get(id);
      if (!s || s.deleted) return this.json(200, { metrics: [] });
      return this.json(200, {
        metrics: [
          {
            unit: '%',
            namespace: 'SYS.ECS',
            metric_name: 'cpu_util',
            dimensions: [{ name: 'instance_id', value: id }],
            datapoints: [{ average: 3.5, timestamp: Number(body.from) }],
          },
        ],
      });
    }
    return this.err(404, 'Common.0014', `no such endpoint ${r.method} ${p}`);
  }

  private create(r: LocalRequest, body: Record<string, any>, region: string): LocalReply {
    const fault = this.take('provision');
    const gate = this.gate(fault);
    if (gate) return gate;
    const s = body.server as Record<string, any> | undefined;
    const ct = String(r.headers['x-client-token'] ?? '');
    if (ct && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ct))
      return this.err(400, 'Ecs.0123', 'invalid idempotency identifier');
    const fl = FLAVORS.find((f) => f.id === s?.flavorRef);
    if (!s || !fl || !s.imageRef || !s.vpcid || !s.nics?.length)
      return this.err(400, 'Ecs.0005', 'request body is illegal.');
    if (fl.specs['cond:operation:status'] === 'sellout')
      return this.err(
        400,
        'Ecs.0018',
        'The selected flavor has been sold out. Try another flavor.',
      );
    if (s.extendparam?.chargingMode !== 'postPaid')
      return this.err(400, 'Ecs.0005', 'V1.1 chargingMode must be a string');
    if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
    const prior = ct ? this.byClientToken.get(ct) : undefined;
    if (prior && this.now() - prior.at < this.clientTokenTtlMs) {
      if (prior.flavor !== s.flavorRef)
        return this.err(400, 'Ecs.0122', 'identifier reused with different parameters');
      return this.json(200, { job_id: randomUUID().replace(/-/g, ''), serverIds: [prior.id] });
    }
    const tags: Record<string, string> = {};
    for (const t of (s.server_tags ?? []) as { key: string; value: string }[])
      tags[t.key] = t.value;
    const id = randomUUID();
    this.servers.set(id, {
      id,
      region,
      name: String(s.name),
      flavor: String(s.flavorRef),
      imageId: String(s.imageRef),
      status: 'ACTIVE',
      tags,
      visibleAt: this.now() + this.lagMs,
      deleted: false,
      ip: `203.0.113.${(this.servers.size % 250) + 1}`, // TEST-NET-3
      ...(ct ? { clientToken: ct } : {}),
      ...(typeof s.user_data === 'string'
        ? { userData: Buffer.from(s.user_data, 'base64').toString('utf8') }
        : {}),
    });
    if (ct) this.byClientToken.set(ct, { id, flavor: String(s.flavorRef), at: this.now() });
    if (fault === 'timeout_after_side_effect') return { status: 200, hang: true };
    return this.json(200, { job_id: randomUUID().replace(/-/g, ''), serverIds: [id] });
  }
}
