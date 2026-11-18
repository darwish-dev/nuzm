import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { Harness, cookieHeader, type App } from '../identity/testing/app-harness';
import { mockStack, type MockStack } from './internal/mock/fixtures';
import {
  InMemoryComputeProvisioning,
  MemoryBackupSink,
  MockDomainOwnershipVerifier,
  NoDatabaseBindingProvider,
} from './internal/mock/mocks';
import { BACKUP_SINK, COMPUTE_PROVISIONING, DOMAIN_VERIFIER, VAULT_PORT } from './internal/ports';
import { HostingJobs } from './internal/hosting-jobs';
import type { MemoryVault } from './internal/mock/mocks';
import { HOSTING_ADAPTER } from './internal/tokens';
import { NodesService } from './internal/nodes.service';

export interface Staff {
  id: string;
  jar: Record<string, string>;
}
export class HostingHarness {
  readonly h = new Harness();
  app!: App;
  stack!: MockStack;
  compute = new InMemoryComputeProvisioning();
  staff: Record<string, Staff> = {};
  seq = 0;
  extraOverrides: [unknown, unknown][] = [];
  verifier!: MockDomainOwnershipVerifier;
  vault!: MemoryVault;
  ids: Record<string, string> = {};
  jars: Record<string, Record<string, string>> = {};
  orgs: Record<string, string> = {};

  async init(opts: { overrides?: [unknown, unknown][]; stack?: MockStack } = {}) {
    await this.h.init();
    process.env.HOSTING_KICK = 'off';
    process.env.HOSTING_DOWNLOAD_LINK_TTL_SECONDS = '2'; // operations run only when a test runs them: deterministic
    process.env.WORKER_DATABASE_URL = this.h.env.workerUrl;
    this.stack = opts.stack ?? mockStack();
    this.verifier = new MockDomainOwnershipVerifier();
    this.vault = this.stack.vault;
    const { app } = await this.h.buildApp({}, undefined, [], {
      realAudit: true,
      overrides: [
        [HOSTING_ADAPTER, this.stack.adapter],
        [COMPUTE_PROVISIONING, this.compute],
        [DOMAIN_VERIFIER, this.verifier],
        [VAULT_PORT, this.stack.vault],
        [BACKUP_SINK, this.stack.sink],
        ...(opts.overrides ?? []),
      ],
    });
    this.app = app;
    await this.h.env.sql(
      `INSERT INTO platform.feature_flags (id, key, org_id, value) VALUES (gen_random_uuid(), 'hosting.enabled', NULL, 'true')`,
    );
    this.staff.root = await this.h.platformUser(app, 'root', ['platform_admin']);
    this.staff.host = await this.h.platformUser(app, 'host', ['hosting_admin']);
    this.staff.host2 = await this.h.platformUser(app, 'host2', ['hosting_admin']);
    this.staff.support = await this.h.platformUser(app, 'support', ['support']);
    this.staff.finance = await this.h.platformUser(app, 'finance', ['finance']);
    return this;
  }
  get env() {
    return this.h.env;
  }
  admin(
    who: string,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: object,
    extra: Record<string, string> = {},
    key?: string | null,
  ) {
    return this.app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(this.staff[who]!.jar),
        'x-csrf-token': this.staff[who]!.jar.nuzm_admin_csrf!,
        ...(method === 'POST' && key !== null
          ? { 'idempotency-key': key ?? `k-${++this.seq}-${Math.random()}` }
          : {}),
        ...extra,
      },
      ...(body ? { payload: body } : {}),
    });
  }
  /** Add a running compute instance, register it as a node, enrol its agent, inventory it and make it active. Returns the node id. */
  async activeNode(
    name: string,
    dataRegion = 'sa-central',
    instance = `fake-${name}`,
  ): Promise<string> {
    this.compute.add({
      computeInstanceId: instance,
      region: dataRegion,
      dataRegion,
      vcpu: 4,
      memoryMb: 8192,
      diskGb: 200,
      status: 'running',
    });
    const c = await this.admin('host', 'POST', '/v1/admin/hosting/nodes', {
      name,
      computeInstanceId: instance,
    });
    if (c.statusCode !== 201) throw new Error('node create failed: ' + c.body);
    const { node, enrolmentToken } = c.json();
    this.stack.addNode(node.id as string, { region: dataRegion });
    const svc = this.app.get(NodesService);
    await svc.enrol(enrolmentToken, createHash('sha256').update(name).digest('hex'), '0.1.0-mock');
    await this.admin('host', 'POST', `/v1/admin/hosting/nodes/${node.id}/inventory`);
    const etag = (await this.admin('host', 'GET', `/v1/admin/hosting/nodes/${node.id}`)).headers
      .etag as string;
    const act = await this.admin(
      'host',
      'PATCH',
      `/v1/admin/hosting/nodes/${node.id}`,
      { status: 'active' },
      { 'if-match': etag },
    );
    if (act.statusCode !== 200) throw new Error('node activation failed: ' + act.body);
    return node.id as string;
  }
  /** Users (created + elevated), two organizations (`A` owned by alice, `B` by bob) and carol (viewer) / erin (developer) in A. */
  async customers() {
    for (const n of ['alice', 'bob', 'carol', 'erin']) {
      this.ids[n] = await this.h.createUser(n);
      this.jars[n] = await this.h.sessionFor(this.app, this.ids[n]!);
      await this.h.elevate(this.jars[n]!);
    }
    this.orgs.A = (
      await this.call('alice', 'POST', '/v1/organizations', { name: 'Hosting A' }, '')
    ).json().id;
    this.orgs.B = (
      await this.call('bob', 'POST', '/v1/organizations', { name: 'Hosting B' }, '')
    ).json().id;
    for (const [u, role] of [
      ['carol', 'viewer'],
      ['erin', 'developer'],
    ] as const)
      await this.env.sql(
        `INSERT INTO tenancy.memberships (id, org_id, user_id, role) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [this.orgs.A, this.ids[u], role],
      );
  }
  call(
    who: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: object,
    org = this.orgs.A!,
    extra: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(this.jars[who]!),
        'x-csrf-token': this.jars[who]!.nuzm_csrf ?? '',
        'x-nuzm-org': org,
        ...(method === 'POST' ? { 'idempotency-key': `k-${++this.seq}-${Math.random()}` } : {}),
        ...extra,
      },
      ...(body ? { payload: body } : {}),
    });
  }
  async project(org: string): Promise<string> {
    const [ws] = await this.env.sql(
      `INSERT INTO tenancy.workspaces (id, org_id, name, slug, created_by) VALUES (gen_random_uuid(), $1, 'ws', $2, $3) RETURNING id`,
      [org, `ws-${Math.random().toString(36).slice(2, 8)}`, this.ids.alice],
    );
    const [p] = await this.env.sql(
      `INSERT INTO tenancy.projects (id, org_id, workspace_id, name, created_by) VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
      [org, ws!.id, `proj-${Math.random().toString(36).slice(2, 8)}`, this.ids.alice],
    );
    return p!.id as string;
  }
  async plan(
    key: string,
    over: {
      cpu?: number;
      mem?: number;
      disk?: number;
      runtimes?: string[];
      price?: number | null;
      quotas?: object;
    } = {},
  ): Promise<string> {
    const [r] = await this.env.sql(
      `INSERT INTO hosting.plan_definitions (id, key, name_ar, name_en, status, quotas, runtimes, reservation, price_minor, placeholder) VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4, $5, $6, $7, false) RETURNING id`,
      [
        key,
        `خطة ${key}`,
        `Plan ${key}`,
        JSON.stringify({
          diskMb: 100,
          inodes: 5000,
          bandwidthGb: 10,
          dbCount: 1,
          sitesCount: 1,
          maxProcesses: 20,
          ...(over.quotas ?? {}),
        }),
        JSON.stringify(over.runtimes ?? ['php', 'nodejs', 'static']),
        JSON.stringify({
          cpu_millicores: over.cpu ?? 250,
          memory_mb: over.mem ?? 256,
          disk_mb: over.disk ?? 1000,
        }),
        over.price === undefined ? 10000 : over.price,
      ],
    );
    return r!.id as string;
  }
  async quote(who: string, org: string, planId: string, runtime: string) {
    return this.call(
      who,
      'POST',
      '/v1/quotes',
      { kind: 'hosting', items: [{ planId, runtime }] },
      org,
    );
  }
  /** Quote + create a site; returns the response. */
  async createSite(
    who: string,
    org: string,
    planId: string,
    runtime: string,
    name: string,
    projectId: string,
    extra: object = {},
  ) {
    const q = await this.quote(who, org, planId, runtime);
    if (q.statusCode !== 201) throw new Error('quote failed: ' + q.body);
    return this.call(
      who,
      'POST',
      '/v1/hosting/sites',
      { quoteId: q.json().id, planId, name, projectId, runtime, ...extra },
      org,
    );
  }
  jobs() {
    return this.app.get(HostingJobs);
  }
  async close() {
    await this.h.close();
  }
}
export {
  cookieHeader,
  uuidv7,
  MemoryBackupSink,
  MockDomainOwnershipVerifier,
  NoDatabaseBindingProvider,
};
