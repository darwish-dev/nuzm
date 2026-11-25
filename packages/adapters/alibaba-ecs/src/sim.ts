import { randomUUID } from 'node:crypto';
import {
  startLocalServer,
  type LocalReply,
  type LocalRequest,
  type LocalServer,
} from '@nuzm/adapter-http';
import { signV3 } from './signer';

/**
 * Local simulator of the Alibaba Cloud ECS / BSS RPC APIs, shaped ONLY from the official documentation (see ../README.md for pages and the
 * date read). It verifies the V3 signature with the same algorithm, then answers the documented actions with documented field names.
 * It proves nothing about the real service: every result obtained through it is NOT VERIFIED. Behaviour the docs do not state (HTTP status
 * of DryRunOperation, listing lag after RunInstances, ClientToken validity window) is configurable here, never assumed by the adapter.
 */
export type SimFaultOp = 'provision' | 'inspect' | 'findByToken' | 'delete' | 'act';
export type SimFaultKind =
  'timeout_after_side_effect' | 'timeout_before_side_effect' | 'rate_limit' | 'outage';

export interface SimInstance {
  id: string;
  region: string;
  type: string;
  imageId: string;
  name: string;
  tags: Record<string, string>;
  status: 'Running' | 'Stopped' | 'Pending';
  visibleAt: number;
  deleted: boolean;
  keyPair?: string;
  clientToken?: string;
  /** the Base64 `UserData` exactly as the API received it */
  userDataB64?: string;
  snapshots: string[];
}

const TYPES = [
  { id: 'ecs.g6.large', cpu: 2, mem: 8, rx: 1_024_000, stock: 'WithStock', usd: 0.17 },
  { id: 'ecs.g6.xlarge', cpu: 4, mem: 16, rx: 1_500_000, stock: 'WithStock', usd: 0.165 },
  { id: 'ecs.g6.2xlarge', cpu: 8, mem: 32, rx: 2_500_000, stock: 'WithoutStock', usd: 0.33 },
  { id: 'ecs.g6.4xlarge', cpu: 16, mem: 64, rx: 5_000_000, stock: 'WithStock', usd: 0.66 }, // beyond the catalog's CPU filter
];

export class AlibabaSim {
  readonly instances = new Map<string, SimInstance>();
  readonly calls: { action: string; region: string; dryRun: boolean }[] = [];
  readonly keyPairs = new Set<string>();
  readonly credentials = {
    accessKeyId: 'LTAIsimulatedkeyid0001',
    accessKeySecret: 'sim-access-key-secret-value-0001',
  };
  /** Actions the simulated RAM user may NOT perform (DryRun answers Forbidden.RAM). */
  readonly forbidden = new Set<string>();
  regions = [
    { RegionId: 'ap-southeast-1', LocalName: 'Singapore', Status: 'available' },
    { RegionId: 'me-central-1', LocalName: 'Saudi Arabia (Riyadh)', Status: 'available' },
    { RegionId: 'me-east-1', LocalName: 'UAE (Dubai)', Status: 'soldOut' },
    { RegionId: 'cn-hangzhou', LocalName: 'China (Hangzhou)', Status: 'available' },
  ];
  bills: {
    InstanceID: string;
    PretaxAmount: number;
    Currency: string;
    BillingCycle: string;
    InstanceSpec: string;
    BillingDate: string;
  }[] = [];
  /** Does the simulated vendor dedupe on ClientToken? (the docs say yes) */
  dedupe = true;
  private faults: { op: SimFaultOp; kind: SimFaultKind; left: number }[] = [];
  private seq = 1000;
  private lagMs = 0;
  private readonly byToken = new Map<string, string>();
  private readonly nonces = new Set<string>();
  private server: LocalServer | null = null;

  constructor(private readonly now: () => number) {
    this.seed();
  }
  private seed(): void {
    this.instances.set('i-seed0000000001', {
      id: 'i-seed0000000001',
      region: 'ap-southeast-1',
      type: 'ecs.g6.large',
      imageId: 'aliyun_3_x64_20G_alibase_20240101.vhd',
      name: 'pre-existing',
      tags: {},
      status: 'Running',
      visibleAt: 0,
      deleted: false,
      snapshots: [],
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
    return [...this.instances.values()].filter((i) => !i.deleted).length;
  }
  billableByToken(token: string): number {
    return [...this.instances.values()].filter((i) => !i.deleted && i.tags['nuzm-token'] === token)
      .length;
  }

  private take(op: SimFaultOp): SimFaultKind | null {
    const f = this.faults.find((x) => x.op === op && x.left > 0);
    if (!f) return null;
    f.left -= 1;
    return f.kind;
  }
  private err(status: number, code: string, message: string): LocalReply {
    return {
      status,
      body: JSON.stringify({
        RequestId: randomUUID().toUpperCase(),
        HostId: 'sim',
        Code: code,
        Message: message,
      }),
    };
  }
  private ok(body: Record<string, unknown>): LocalReply {
    return {
      status: 200,
      body: JSON.stringify({ RequestId: randomUUID().toUpperCase(), ...body }),
    };
  }
  private gate(kind: SimFaultKind | null): LocalReply | null {
    if (kind === 'rate_limit')
      return this.err(400, 'Throttling.User', 'Request was denied due to user flow control.');
    if (kind === 'outage')
      return this.err(
        503,
        'ServiceUnavailable',
        'The request has failed due to a temporary failure of the server.',
      );
    return null;
  }
  private visible(i: SimInstance): boolean {
    return !i.deleted && i.visibleAt <= this.now();
  }
  private view(i: SimInstance) {
    const n = Number(i.id.replace(/\D/g, '').slice(-3)) % 250;
    return {
      InstanceId: i.id,
      InstanceName: i.name,
      RegionId: i.region,
      InstanceType: i.type,
      ImageId: i.imageId,
      Status: i.status,
      Cpu: TYPES.find((t) => t.id === i.type)?.cpu ?? 2,
      Memory: (TYPES.find((t) => t.id === i.type)?.mem ?? 8) * 1024,
      PublicIpAddress: { IpAddress: i.deleted ? [] : [`192.0.2.${n + 1}`] }, // TEST-NET-1
      EipAddress: { IpAddress: '' },
      Tags: { Tag: Object.entries(i.tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue })) },
      CreationTime: '2026-01-01T00:00Z',
      ...(i.keyPair ? { KeyPairName: i.keyPair } : {}),
    };
  }

  private verify(r: LocalRequest): LocalReply | null {
    const h = (n: string) => String(r.headers[n] ?? '');
    const auth =
      /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]+)$/.exec(
        h('authorization'),
      );
    if (!auth) return this.err(400, 'MissingAuthorization', 'signature required');
    if (auth[1] !== this.credentials.accessKeyId)
      return this.err(
        404,
        'InvalidAccessKeyId.NotFound',
        'The Access Key ID provided does not exist in our records.',
      );
    const date = h('x-acs-date');
    if (Math.abs(Date.parse(date) - this.now()) > 15 * 60_000)
      return this.err(
        400,
        'InvalidTimeStamp.Expired',
        'The specified time stamp or date value is not well formatted.',
      );
    const nonce = h('x-acs-signature-nonce');
    if (this.nonces.has(nonce)) return this.err(400, 'SignatureNonceUsed', 'nonce reused');
    this.nonces.add(nonce);
    const q: Record<string, string> = {};
    r.query.forEach((v, k) => (q[k] = v));
    const again = signV3({
      method: r.method as 'GET' | 'POST',
      host: h('host'),
      action: h('x-acs-action'),
      version: h('x-acs-version'),
      query: q,
      date,
      nonce,
      accessKeyId: auth[1]!,
      accessKeySecret: this.credentials.accessKeySecret,
    });
    if (again.headers.authorization !== h('authorization'))
      return this.err(
        400,
        'SignatureDoesNotMatch',
        'The signature we calculated does not match the one you provided.',
      );
    return null;
  }

  private async handle(r: LocalRequest): Promise<LocalReply> {
    const bad = this.verify(r);
    if (bad) return bad;
    const action = String(r.headers['x-acs-action']);
    const q = Object.fromEntries(r.query.entries());
    const region = q.RegionId ?? '';
    const dry = q.DryRun === 'true';
    this.calls.push({ action, region, dryRun: dry });
    const DRY = new Set([
      'RunInstances',
      'StartInstance',
      'StopInstance',
      'RebootInstance',
      'ModifyInstanceSpec',
      'DeleteInstance',
    ]);
    if (dry && DRY.has(action)) {
      if (this.forbidden.has(action))
        return this.err(
          403,
          'Forbidden.RAM',
          "User not authorized to operate on the specified resource, or this API doesn't support RAM.",
        );
      // The HTTP status of DryRunOperation is NOT DOCUMENTED; the adapter keys on the Code only.
      return this.err(
        403,
        'DryRunOperation',
        'Request validation has been passed with DryRun flag set.',
      );
    }
    switch (action) {
      case 'DescribeRegions':
        return this.ok({
          Regions: {
            Region: this.regions.map((x) => ({
              ...x,
              RegionEndpoint: `ecs.${x.RegionId}.aliyuncs.com`,
            })),
          },
        });
      case 'DescribeAvailableResource': {
        return this.ok({
          AvailableZones: {
            AvailableZone: [
              {
                ZoneId: `${region}a`,
                RegionId: region,
                Status: 'Available',
                StatusCategory: 'WithStock',
                AvailableResources: {
                  AvailableResource: [
                    {
                      Type: 'InstanceType',
                      SupportedResources: {
                        SupportedResource: TYPES.map((t) => ({
                          Status: t.stock === 'WithStock' ? 'Available' : 'SoldOut',
                          Value: t.id,
                          StatusCategory: t.stock,
                        })),
                      },
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      case 'DescribeInstanceTypes': {
        const minC = Number(q.MinimumCpuCoreCount ?? 0),
          maxC = Number(q.MaximumCpuCoreCount ?? 1e9),
          maxM = Number(q.MaximumMemorySize ?? 1e9);
        const fam = q.InstanceTypeFamily;
        return this.ok({
          InstanceTypes: {
            InstanceType: TYPES.filter(
              (t) =>
                t.cpu >= minC &&
                t.cpu <= maxC &&
                t.mem <= maxM &&
                (!fam || t.id.startsWith(`${fam}.`)),
            ).map((t) => ({
              InstanceTypeId: t.id,
              InstanceTypeFamily: 'ecs.g6',
              CpuCoreCount: t.cpu,
              MemorySize: t.mem,
              InstanceBandwidthRx: t.rx,
            })),
          },
          NextToken: '',
        });
      }
      case 'DescribePrice': {
        const t = TYPES.find((x) => x.id === q.InstanceType);
        if (!t)
          return this.err(
            400,
            'InvalidInstanceType.ValueNotSupported',
            'The specified InstanceType does not exist or beyond the permitted range.',
          );
        return this.ok({
          PriceInfo: {
            Price: { Currency: 'USD', OriginalPrice: t.usd, DiscountPrice: 0, TradePrice: t.usd },
            Rules: { Rule: [] },
          },
        });
      }
      case 'DescribeImages':
        return this.ok({
          PageSize: 100,
          PageNumber: 1,
          TotalCount: 1,
          RegionId: region,
          Images: {
            Image: [
              {
                ImageId: 'aliyun_3_x64_20G_alibase_20240101.vhd',
                OSType: 'linux',
                OSNameEn: 'Alibaba Cloud Linux 3',
                Status: 'Available',
                IsSupportCloudinit: true,
              },
            ],
          },
        });
      case 'ImportKeyPair':
        if (this.keyPairs.has(`${region}/${q.KeyPairName}`))
          return this.err(400, 'KeyPair.AlreadyExist', 'The specified KeyPairName already exists.');
        this.keyPairs.add(`${region}/${q.KeyPairName}`);
        return this.ok({ KeyPairName: q.KeyPairName, KeyPairFingerPrint: 'aa:bb' });
      case 'RunInstances':
        return this.runInstances(q, region);
      case 'DescribeInstances': {
        const tagged = q['Tag.1.Key'] === 'nuzm-token';
        const gate = this.gate(this.take(tagged ? 'findByToken' : 'inspect'));
        if (gate) return gate;
        let items = [...this.instances.values()].filter(
          (i) => this.visible(i) && i.region === region,
        );
        if (q.InstanceIds)
          items = items.filter((i) => (JSON.parse(q.InstanceIds!) as string[]).includes(i.id));
        if (tagged) items = items.filter((i) => i.tags['nuzm-token'] === q['Tag.1.Value']);
        return this.ok({
          Instances: { Instance: items.map((i) => this.view(i)) },
          NextToken: '',
          TotalCount: items.length,
        });
      }
      case 'StartInstance':
      case 'StopInstance':
      case 'RebootInstance':
      case 'ModifyInstanceSpec':
      case 'CreateSnapshot':
      case 'DeleteInstance':
        return this.mutate(action, q);
      case 'DescribeDisks': {
        const i = this.instances.get(q.InstanceId ?? '');
        if (!i || !this.visible(i)) return this.ok({ Disks: { Disk: [] } });
        return this.ok({
          Disks: { Disk: [{ DiskId: `d-${i.id}`, Type: 'system', Size: 40, InstanceId: i.id }] },
          TotalCount: 1,
        });
      }
      case 'DescribeInstanceMonitorData': {
        const i = this.instances.get(q.InstanceId ?? '');
        if (!i || !this.visible(i))
          return this.err(
            404,
            'InvalidInstanceId.NotFound',
            'The specified InstanceId does not exist.',
          );
        return this.ok({
          MonitorData: {
            InstanceMonitorData: [
              {
                InstanceId: i.id,
                TimeStamp: q.StartTime,
                CPU: 2,
                InternetRX: 122,
                InternetTX: 343,
                BPSRead: 1000,
                BPSWrite: 13585,
                IOPSRead: 1000,
                IOPSWrite: 200,
              },
            ],
          },
        });
      }
      case 'DescribeInstanceBill': {
        const items = this.bills.filter((b) => b.BillingCycle === q.BillingCycle);
        const size = Number(q.MaxResults ?? 20);
        const start = Number(q.NextToken || 0);
        const page = items.slice(start, start + size);
        const next = start + size < items.length ? String(start + size) : '';
        return this.ok({
          Code: 'Success',
          Message: 'Successful!',
          Success: true,
          Data: {
            BillingCycle: q.BillingCycle,
            Items: page,
            MaxResults: size,
            NextToken: next,
            TotalCount: items.length,
          },
        });
      }
    }
    return this.err(404, 'InvalidAction.NotFound', `unknown action ${action}`);
  }

  private async runInstances(q: Record<string, string>, region: string): Promise<LocalReply> {
    const fault = this.take('provision');
    const gate = this.gate(fault);
    if (gate) return gate;
    const t = TYPES.find((x) => x.id === q.InstanceType);
    if (!t || !region)
      return this.err(
        400,
        'InvalidInstanceType.ValueNotSupported',
        'The specified InstanceType does not exist or beyond the permitted range.',
      );
    if (t.stock !== 'WithStock')
      return this.err(403, 'OperationDenied.NoStock', 'The resource is out of usage.');
    if (!q.VSwitchId || !q.SecurityGroupId)
      return this.err(
        400,
        'MissingParameter',
        'VSwitchId and SecurityGroupId are required for VPC instances.',
      );
    if (!q.ClientToken || !/^[\x20-\x7e]{1,64}$/.test(q.ClientToken))
      return this.err(
        403,
        'InvalidClientToken.Malformed',
        'ClientToken must be ASCII and at most 64 characters.',
      );
    if (q.UserData !== undefined) {
      // documented: Base64, "cannot exceed 32 KB before Base64 encoding" (InvalidUserData.Base64FormatInvalid / InvalidUserData.SizeExceeded)
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(q.UserData) || q.UserData.length % 4 !== 0)
        return this.err(
          400,
          'InvalidUserData.Base64FormatInvalid',
          'The specified UserData is not Base64 encoded.',
        );
      if (Buffer.from(q.UserData, 'base64').length > 32 * 1024)
        return this.err(
          400,
          'InvalidUserData.SizeExceeded',
          'The specified UserData exceeds the size.',
        );
    }
    if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
    const prior = this.byToken.get(q.ClientToken);
    if (this.dedupe && prior) {
      const p = this.instances.get(prior)!;
      if (p.type !== q.InstanceType || (p.userDataB64 ?? '') !== (q.UserData ?? ''))
        return this.err(403, 'IdempotentParameterMismatch', 'The specified clientToken is used.');
      return this.ok({ InstanceIdSets: { InstanceIdSet: [prior] }, TradePrice: t.usd });
    }
    const tags: Record<string, string> = {};
    for (let n = 1; n <= 20; n++)
      if (q[`Tag.${n}.Key`]) tags[q[`Tag.${n}.Key`]!] = q[`Tag.${n}.Value`] ?? '';
    const i: SimInstance = {
      id: `i-sim${String(++this.seq).padStart(10, '0')}`,
      region,
      type: q.InstanceType!,
      imageId: q.ImageId ?? '',
      name: q.InstanceName ?? '',
      tags,
      status: 'Running',
      visibleAt: this.now() + this.lagMs,
      deleted: false,
      clientToken: q.ClientToken,
      snapshots: [],
      ...(q.KeyPairName ? { keyPair: q.KeyPairName } : {}),
      ...(q.UserData !== undefined ? { userDataB64: q.UserData } : {}),
    };
    this.instances.set(i.id, i);
    this.byToken.set(q.ClientToken, i.id);
    if (fault === 'timeout_after_side_effect') return { status: 200, hang: true };
    return this.ok({ InstanceIdSets: { InstanceIdSet: [i.id] }, TradePrice: t.usd });
  }

  private mutate(action: string, q: Record<string, string>): LocalReply {
    const fault = this.take(action === 'DeleteInstance' ? 'delete' : 'act');
    const gate = this.gate(fault);
    if (gate) return gate;
    if (action === 'CreateSnapshot') {
      const i = this.instances.get(String(q.DiskId).replace(/^d-/, ''));
      if (!i)
        return this.err(404, 'InvalidDiskId.NotFound', 'The specified DiskId does not exist.');
      i.snapshots.push(q.SnapshotName ?? '');
      return this.ok({ SnapshotId: `s-${i.id}` });
    }
    const i = this.instances.get(q.InstanceId ?? '');
    if (!i || i.deleted)
      return this.err(
        404,
        'InvalidInstanceId.NotFound',
        'The specified InstanceId does not exist.',
      );
    if (fault === 'timeout_before_side_effect') return { status: 200, hang: true };
    switch (action) {
      case 'StartInstance':
        if (i.status !== 'Stopped')
          return this.err(
            403,
            'IncorrectInstanceStatus',
            'The current status of the resource does not support this operation.',
          );
        i.status = 'Running';
        break;
      case 'StopInstance':
        i.status = 'Stopped';
        break;
      case 'RebootInstance':
        if (i.status !== 'Running')
          return this.err(
            403,
            'IncorrectInstanceStatus',
            'The current status of the resource does not support this operation.',
          );
        break;
      case 'ModifyInstanceSpec':
        if (i.status !== 'Stopped')
          return this.err(400, 'InvalidInstanceStatus.NotStopped', 'The instance must be stopped.');
        if (!TYPES.some((t) => t.id === q.InstanceType))
          return this.err(400, 'InvalidInstanceType.ValueNotSupported', 'bad type');
        i.type = q.InstanceType!;
        break;
      case 'DeleteInstance':
        if (q.Force !== 'true' && i.status !== 'Stopped')
          return this.err(
            403,
            'IncorrectInstanceStatus',
            'The instance must be stopped when Force=false.',
          );
        i.deleted = true;
        break;
    }
    if (fault === 'timeout_after_side_effect') return { status: 200, hang: true };
    return this.ok({});
  }
}
