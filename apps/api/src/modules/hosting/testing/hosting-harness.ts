import { v7 as uuidv7 } from 'uuid';
import { Harness, cookieHeader, type App } from '../../identity/testing/app-harness';
import { mockStack, type MockStack } from '../internal/mock/fixtures';
import { InMemoryComputeProvisioning, MemoryBackupSink, MockDomainOwnershipVerifier, NoDatabaseBindingProvider } from '../internal/mock/mocks';
import { COMPUTE_PROVISIONING } from '../internal/ports';
import { HOSTING_ADAPTER } from '../internal/tokens';

/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed JSON in tests */
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

  async init(opts: { overrides?: [unknown, unknown][]; stack?: MockStack } = {}) {
    await this.h.init();
    this.stack = opts.stack ?? mockStack();
    const { app } = await this.h.buildApp({}, undefined, [], {
      realAudit: true,
      overrides: [[HOSTING_ADAPTER, this.stack.adapter], [COMPUTE_PROVISIONING, this.compute], ...(opts.overrides ?? [])],
    });
    this.app = app;
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
  admin(who: string, method: 'GET' | 'POST' | 'PATCH', url: string, body?: object, extra: Record<string, string> = {}, key?: string | null) {
    return this.app.inject({
      method,
      url,
      headers: {
        cookie: cookieHeader(this.staff[who]!.jar),
        'x-csrf-token': this.staff[who]!.jar.nuzm_admin_csrf!,
        ...(method === 'POST' && key !== null ? { 'idempotency-key': key ?? `k-${++this.seq}-${Math.random()}` } : {}),
        ...extra,
      },
      ...(body ? { payload: body } : {}),
    });
  }
  /** Add a running compute instance, register it as a node, enrol its agent, inventory it and make it active. Returns the node id. */
  async activeNode(name: string, dataRegion = 'SA', instance = `fake-${name}`): Promise<string> {
    this.compute.add({ computeInstanceId: instance, region: dataRegion, dataRegion, vcpu: 4, memoryMb: 8192, diskGb: 200, status: 'running' });
    const c = await this.admin('host', 'POST', '/v1/admin/hosting/nodes', { name, computeInstanceId: instance });
    if (c.statusCode !== 201) throw new Error('node create failed: ' + c.body);
    const { node, enrolmentToken } = c.json();
    this.stack.addNode(node.id as string);
    const svc = this.app.get((await import('../internal/nodes.service')).NodesService);
    await svc.enrol(enrolmentToken, 'a'.repeat(63) + name.length.toString(16).slice(-1), '0.1.0-mock');
    return node.id as string;
  }
  async close() {
    await this.h.close();
  }
}
export { cookieHeader, uuidv7, MemoryBackupSink, MockDomainOwnershipVerifier, NoDatabaseBindingProvider };
