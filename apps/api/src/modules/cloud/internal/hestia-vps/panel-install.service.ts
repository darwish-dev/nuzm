import type { PoolClient } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '@nuzm/platform';
import type { AuditSink } from '../../../../common/audit';
import { ProblemException } from '../../../../common/errors';
import type { SealedVault } from '../../../../common/sealed-vault';
import type { AdapterRegistry } from '../adapter-registry';
import { iso, pgCode, type Row } from '../common';
import type { CloudFlags } from '../flags';
import type { ProvisioningService } from '../provisioning.service';
import {
  buildUserData,
  hashSecret,
  newRegistration,
  parseRegistrationToken,
  secretMatches,
} from './bootstrap';
import type { PanelDnsPort, PanelNodePort } from './ports';
import {
  HESTIA_MIN,
  isSupportedOs,
  panelHostFor,
  parseOsImage,
  type ConfigSource,
  type HestiaTemplate,
  type HestiaVpsConfig,
  type OsId,
} from './policy';

export const STAGES = [
  'create_server',
  'waiting_boot',
  'installing_panel',
  'registering',
  'readiness',
  'ready',
  'needs_attention',
  'held',
] as const;
export type Stage = (typeof STAGES)[number];
type ResumeStage =
  'create_server' | 'waiting_boot' | 'installing_panel' | 'registering' | 'readiness';

/** The order snapshot (image, template, region, provider plan, pinned installer): stored in the quote and copied into `compute.panel_installs`. */
export interface PanelSnapshot {
  kind: 'hestia';
  template: HestiaTemplate;
  panelVersion: string;
  installerUrl: string;
  installerSha256: string;
  osId: OsId;
  osVersion: string;
  imageRef: string;
  imageName: string;
  providerKey: string;
  providerRegionId: string;
  planRef: string;
}

/** Attention codes the customer or an administrator can resume WITHOUT touching the server (the failure was on Nuzm's side or only needs time). */
const NUZM_SIDE = new Set([
  'boot_timeout',
  'readiness_failed',
  'panel_dns_not_configured',
  'dns_failed',
  'node_register_failed',
  'vault_unavailable',
  'server_not_running',
]);
/** Codes that mean the bootstrap on the server did not finish: resumable on the SAME server by re-running the script (the registration window is extended), never by wiping it. */
const SERVER_SIDE = new Set([
  'install_timeout',
  'registration_expired',
  'bootstrap_download_failed',
  'bootstrap_install_failed',
  'bootstrap_key_failed',
  'bootstrap_profile_failed',
  'bootstrap_probe_failed',
  'bootstrap_register_failed',
  'bootstrap_password_failed',
  'bootstrap_no_root_home',
]);
export const RERUN_COMMAND = 'sudo bash /usr/local/sbin/nuzm-bootstrap.sh';
const LINK_CHECK_MS = 15 * 60_000;

export interface PanelDto {
  kind: 'hestia';
  stage: Stage;
  steps: {
    key: 'create_server' | 'wait_boot' | 'install_panel' | 'register' | 'readiness';
    state: 'pending' | 'running' | 'done' | 'failed';
  }[];
  template: HestiaTemplate;
  panelVersion: string;
  osName: string;
  panelHost: string;
  panelPort: number;
  panelLink: 'none' | 'connected' | 'lost';
  attention: {
    code: string;
    detail: string | null;
    resumable: 'here' | 'server' | 'support';
  } | null;
  holdReason: string | null;
  ready: boolean;
  rerunCommand: string | null;
  adminPasswordFile: string;
  updatedAt: string;
}

const STEP_OF: Record<string, PanelDto['steps'][number]['key']> = {
  create_server: 'create_server',
  waiting_boot: 'wait_boot',
  installing_panel: 'install_panel',
  registering: 'register',
  readiness: 'readiness',
};
const STEP_KEYS: PanelDto['steps'][number]['key'][] = [
  'create_server',
  'wait_boot',
  'install_panel',
  'register',
  'readiness',
];

export function toPanelDto(r: Row, holdReason: string | null = null): PanelDto {
  const stage = r.stage as Stage;
  const at: Stage | ResumeStage =
    stage === 'ready'
      ? 'readiness'
      : stage === 'needs_attention'
        ? ((r.resume_stage as ResumeStage) ?? 'create_server')
        : stage === 'held'
          ? 'create_server'
          : stage;
  const idx = STEP_KEYS.indexOf(STEP_OF[at] ?? 'create_server');
  const steps = STEP_KEYS.map((key, i) => ({
    key,
    state: (stage === 'ready' || i < idx
      ? 'done'
      : i === idx
        ? stage === 'needs_attention' || stage === 'held'
          ? 'failed'
          : 'running'
        : 'pending') as 'done' | 'failed' | 'running' | 'pending',
  }));
  const code = (r.attention_code as string | null) ?? null;
  return {
    kind: 'hestia',
    stage,
    steps,
    template: r.template as HestiaTemplate,
    panelVersion: (r.panel_version_seen as string | null) ?? (r.panel_version as string),
    osName: r.image_name as string,
    panelHost: r.panel_host as string,
    panelPort: Number(r.panel_port),
    panelLink: r.panel_link as PanelDto['panelLink'],
    attention: code
      ? {
          code,
          detail: (r.attention_detail as string | null) ?? null,
          resumable: NUZM_SIDE.has(code) ? 'here' : SERVER_SIDE.has(code) ? 'server' : 'support',
        }
      : null,
    holdReason,
    ready: stage === 'ready',
    rerunCommand: code && SERVER_SIDE.has(code) ? RERUN_COMMAND : null,
    adminPasswordFile: '/root/.nuzm-panel-admin-password',
    updatedAt: iso(r.updated_at)!,
  };
}

export interface PanelDeps {
  db: Db;
  audit: AuditSink;
  adapters: AdapterRegistry;
  prov: Pick<ProvisioningService, 'access'>;
  flags: Pick<CloudFlags, 'hestiaVpsEnabled'>;
  config: ConfigSource;
  /** the sealed store (non-production profiles). Absent = the production vault (D-12): the product is not available. */
  vault: SealedVault | null;
  nodes: PanelNodePort;
  dns: PanelDnsPort;
}

/**
 * The staged install of HestiaCP on a customer's VPS (S04). One row per order and per server in `compute.panel_installs`; every transition is a compare-and-set on the
 * stage, so a duplicated queue message, a restart in the middle, or two concurrent callbacks can neither skip a stage nor do one twice. The provider server is created by
 * `ProvisioningService` (idempotent: Alibaba `ClientToken`, Contabo reconcile-before-create); this service never creates, replaces or deletes a server.
 */
export class PanelInstallService {
  constructor(private readonly d: PanelDeps) {}
  private now(): Date {
    return new Date(this.d.adapters.clock.now());
  }

  // ---- ordering -------------------------------------------------------------------------------------------------------------
  /** Is the Hestia choice offered for this placement, and which images are verified for it? (`offerId` page of the wizard) */
  async verifiedImageRefs(
    orgId: string,
    accountId: string,
    providerKey: string,
    providerRegionId: string,
  ): Promise<Set<string>> {
    const cfg = this.d.config.get();
    if (
      !cfg ||
      !this.d.vault ||
      !(await this.d.flags.hestiaVpsEnabled(orgId)) ||
      !this.placementOk(cfg, providerKey, providerRegionId)
    )
      return new Set();
    const rows = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT i.image_ref, i.name, a.os_id, a.os_version
               FROM compute.images i JOIN compute.panel_image_approvals a
                 ON a.account_id = i.account_id AND a.provider_region_id = i.provider_region_id AND a.image_ref = i.image_ref
              WHERE i.account_id = $1 AND i.provider_region_id = $2 AND i.cloud_init IS TRUE
                AND a.panel_kind = 'hestia' AND a.panel_version = $3 AND a.revoked_at IS NULL`,
            [accountId, providerRegionId, cfg.panelVersion],
          )
        ).rows as Row[],
    );
    const out = new Set<string>();
    for (const r of rows) {
      const os = parseOsImage(r.name as string);
      if (
        os &&
        os.osId === r.os_id &&
        os.osVersion === r.os_version &&
        isSupportedOs(os.osId, os.osVersion) &&
        cfg.installerSha256[os.osId]
      )
        out.add(r.image_ref as string);
    }
    return out;
  }
  private placementOk(cfg: HestiaVpsConfig, provider: string, region: string) {
    return cfg.placements.some((p) => p.provider === provider && p.region === region);
  }

  /** Quote time: validates the Hestia choice against everything that must hold and returns the snapshot stored with the order. Provider identity stays internal. */
  async planOrder(
    orgId: string,
    template: HestiaTemplate,
    chosen: {
      accountId: string;
      providerKey: string;
      providerRegionId: string;
      planRef: string;
      vcpu: number;
      memoryMb: number;
      diskGb: number;
    },
    image: { imageRef: string; name: string },
  ): Promise<PanelSnapshot> {
    const na = (m: string) => new ProblemException('unsupported_capability', m);
    if (!(await this.d.flags.hestiaVpsEnabled(orgId)))
      throw na('a VPS with HestiaCP is not enabled for this organization');
    const cfg = this.d.config.get();
    if (!cfg || !this.d.vault)
      throw na('a VPS with HestiaCP is not available yet: it is not configured');
    if (!this.placementOk(cfg, chosen.providerKey, chosen.providerRegionId))
      throw na('a VPS with HestiaCP is not offered in the selected region');
    const os = parseOsImage(image.name);
    if (!os || !isSupportedOs(os.osId, os.osVersion))
      throw new ProblemException(
        'validation_failed',
        'this operating system image is not supported by HestiaCP',
      );
    const sha = cfg.installerSha256[os.osId];
    if (!sha) throw na('a VPS with HestiaCP is not available for this operating system yet');
    const verified = await this.verifiedImageRefs(
      orgId,
      chosen.accountId,
      chosen.providerKey,
      chosen.providerRegionId,
    );
    if (!verified.has(image.imageRef))
      throw new ProblemException('validation_failed', 'this image is not verified for HestiaCP');
    if (
      chosen.vcpu < HESTIA_MIN.vcpu ||
      chosen.memoryMb < HESTIA_MIN.memoryMb ||
      chosen.diskGb < HESTIA_MIN.diskGb
    )
      throw new ProblemException(
        'validation_failed',
        'this plan is smaller than HestiaCP needs (1 vCPU, 1 GB memory, 10 GB disk)',
      );
    return {
      kind: 'hestia',
      template,
      panelVersion: cfg.panelVersion,
      installerUrl: `${cfg.installerBaseUrl}/hst-install-${os.osId}.sh`,
      installerSha256: sha,
      osId: os.osId,
      osVersion: os.osVersion,
      imageRef: image.imageRef,
      imageName: image.name,
      providerKey: chosen.providerKey,
      providerRegionId: chosen.providerRegionId,
      planRef: chosen.planRef,
    };
  }

  /** Before the quote is consumed: the single-use registration secret is sealed in the vault (read back for identical user data on every retry). */
  async prepareRegistration(): Promise<{
    registrationId: string;
    hash: string;
    secretRef: string;
  }> {
    if (!this.d.vault)
      throw new ProblemException(
        'unsupported_capability',
        'the secret store is not available in this profile (D-12)',
      );
    const registrationId = uuidv7();
    const { secret, hash } = newRegistration(registrationId);
    const secretRef = await this.d.vault.putFields(`hestia-reg-${registrationId}`, { secret });
    return { registrationId, hash, secretRef };
  }

  /** Inside the order transaction: the install row. The unique constraints on `order_id` and `instance_id` make a second install (hence a second server) for one order impossible. */
  async insertInstall(
    c: PoolClient,
    a: {
      orgId: string;
      instanceId: string;
      orderId: string;
      snapshot: PanelSnapshot;
      reg: { registrationId: string; hash: string; secretRef: string };
    },
  ): Promise<void> {
    const cfg = this.d.config.get();
    if (!cfg)
      throw new ProblemException(
        'unsupported_capability',
        'a VPS with HestiaCP is not available yet',
      );
    const s = a.snapshot;
    await c.query(
      `INSERT INTO compute.panel_installs (id, org_id, instance_id, order_id, panel_kind, provider_key, provider_region_id, plan_ref, image_ref, image_name, os_id, os_version,
         template, panel_version, installer_url, installer_sha256, panel_host, registration_id, registration_hash, registration_secret_ref)
       VALUES ($1,$2,$3,$4,'hestia',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        uuidv7(),
        a.orgId,
        a.instanceId,
        a.orderId,
        s.providerKey,
        s.providerRegionId,
        s.planRef,
        s.imageRef,
        s.imageName,
        s.osId,
        s.osVersion,
        JSON.stringify(s.template),
        s.panelVersion,
        s.installerUrl,
        s.installerSha256,
        panelHostFor(a.instanceId, cfg.panelDomain),
        a.reg.registrationId,
        a.reg.hash,
        a.reg.secretRef,
      ],
    );
    await c.query(`UPDATE compute.instances SET panel_kind = 'hestia' WHERE id = $1`, [
      a.instanceId,
    ]);
  }

  /** Execution-time re-check (TOCTOU): the approval was not revoked, the placement is still sold, the flag and the configuration are still on. */
  async stillValid(orgId: string, instanceId: string): Promise<boolean> {
    const cfg = this.d.config.get();
    const r = await this.row(orgId, instanceId);
    if (!cfg || !r || !this.d.vault || !(await this.d.flags.hestiaVpsEnabled(orgId))) return false;
    if (!this.placementOk(cfg, r.provider_key as string, r.provider_region_id as string))
      return false;
    const x = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT r.provider_account_id FROM compute.instances i JOIN cloud.resources r ON r.id = i.resource_id WHERE i.id = $1`,
            [instanceId],
          )
        ).rows[0] as Row | undefined,
    );
    if (!x) return false;
    const ok = await this.verifiedImageRefs(
      orgId,
      x.provider_account_id as string,
      r.provider_key as string,
      r.provider_region_id as string,
    );
    return (
      ok.has(r.image_ref as string) &&
      cfg.panelVersion === r.panel_version &&
      cfg.installerSha256[r.os_id as OsId] === r.installer_sha256
    );
  }

  holdRetryMinutes(): number {
    return this.d.config.get()?.holdRetryMinutes ?? 30;
  }

  /** The order failed before the transaction: the sealed registration secret is not needed. */
  async discard(secretRef: string): Promise<void> {
    await this.d.vault?.delete(secretRef).catch(() => undefined);
  }

  /** The server was deleted: the panel node is retired, the sealed key is removed. */
  async onDeleted(orgId: string, instanceId: string): Promise<void> {
    const r = await this.row(orgId, instanceId);
    if (!r?.panel_node_id) return;
    await this.d.nodes.retire(r.panel_node_id as string).catch(() => undefined);
    const reg = (r.steps as { register?: { keyRef?: string } }).register;
    if (reg?.keyRef) await this.d.vault?.delete(reg.keyRef).catch(() => undefined);
    await this.d.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE compute.panel_installs SET panel_link = 'none', updated_at = now() WHERE id = $1`,
        [r.id],
      ),
    );
  }

  // ---- provisioning hooks ---------------------------------------------------------------------------------------------------
  /** The user data of THIS order's server, built from the stored snapshot and the sealed secret: byte-identical on every retry. */
  async userDataFor(orgId: string, instanceId: string, sshPublicKeys: string[]): Promise<string> {
    const cfg = this.d.config.get();
    const r = await this.row(orgId, instanceId);
    if (!cfg || !r || !this.d.vault || !r.registration_secret_ref)
      throw new Error('panel_install_unavailable');
    const secret = (await this.d.vault.resolve(r.registration_secret_ref as string)).fields.secret;
    if (!secret || !secretMatches(secret, r.registration_hash as string))
      throw new Error('registration_secret_mismatch');
    return buildUserData({
      registrationId: r.registration_id as string,
      registrationSecret: secret,
      callbackBaseUrl: cfg.callbackBaseUrl,
      installerBaseUrl: (r.installer_url as string).replace(/\/[^/]+$/, ''),
      installerSha256: r.installer_sha256 as string,
      osId: r.os_id as OsId,
      panelHost: r.panel_host as string,
      panelPort: Number(r.panel_port),
      template: r.template as HestiaTemplate,
      controlPlaneIps: cfg.controlPlaneIps,
      sshPublicKeys,
    });
  }

  /** Same transaction as the instance becoming `running`: the server exists, the boot window starts now. */
  async markServerCreated(
    c: PoolClient,
    instanceId: string,
    providerRef: string,
    addresses: string[],
    at: Date,
  ): Promise<void> {
    const cfg = this.d.config.get();
    const ttl = (cfg?.registrationTtlMinutes ?? 180) * 60_000;
    await c.query(
      `UPDATE compute.panel_installs SET stage = 'waiting_boot', stage_entered_at = $2, server_ref = $3, server_addresses = $4,
              registration_expires_at = $5, steps = steps || $6::jsonb, updated_at = now(), version = version + 1
        WHERE instance_id = $1 AND stage IN ('create_server','held')`,
      [
        instanceId,
        at,
        providerRef,
        JSON.stringify(addresses),
        new Date(at.getTime() + ttl),
        JSON.stringify({ create_server: { at: at.toISOString() } }),
      ],
    );
  }

  /** The provider has no capacity in the sold region: the order waits there. It is never moved to another region. */
  async markHeld(orgId: string, instanceId: string): Promise<void> {
    await this.d.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE compute.panel_installs SET stage = 'held', stage_entered_at = now(), steps = steps || $2::jsonb, updated_at = now(), version = version + 1
          WHERE instance_id = $1 AND stage IN ('create_server','held')`,
        [
          instanceId,
          JSON.stringify({
            held: { code: 'provider_capacity_unavailable', at: this.now().toISOString() },
          }),
        ],
      );
    });
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------
  private async row(orgId: string, instanceId: string): Promise<Row | undefined> {
    return this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT * FROM compute.panel_installs WHERE instance_id = $1 AND org_id = $2`,
            [instanceId, orgId],
          )
        ).rows[0] as Row | undefined,
    );
  }
  private async byId(id: string): Promise<Row | undefined> {
    return this.d.db.withPlatformScope(
      async (c) =>
        (await c.query(`SELECT * FROM compute.panel_installs WHERE id = $1`, [id])).rows[0] as
          Row | undefined,
    );
  }
  async status(orgId: string, instanceId: string): Promise<PanelDto | null> {
    const r = await this.row(orgId, instanceId);
    if (!r) return null;
    const held = r.stage === 'held' ? 'provider_capacity_unavailable' : null;
    return toPanelDto(r, held);
  }
  async adminList(q: { stage?: string; limit?: number }) {
    const rows = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(
            `SELECT p.*, i.name AS instance_name FROM compute.panel_installs p JOIN compute.instances i ON i.id = p.instance_id
              WHERE ($1::text IS NULL OR p.stage = $1) ORDER BY p.updated_at DESC LIMIT $2`,
            [q.stage ?? null, Math.min(q.limit ?? 50, 200)],
          )
        ).rows as Row[],
    );
    return rows.map((r) => ({
      id: r.id as string,
      orgId: r.org_id as string,
      instanceId: r.instance_id as string,
      orderId: r.order_id as string,
      provider: r.provider_key as string,
      region: r.provider_region_id as string,
      stage: r.stage as Stage,
      attentionCode: (r.attention_code as string | null) ?? null,
      attentionDetail: (r.attention_detail as string | null) ?? null,
      panelVersion: r.panel_version as string,
      panelHost: r.panel_host as string,
      panelLink: r.panel_link as string,
      attempts: r.attempts as number,
      updatedAt: iso(r.updated_at)!,
    }));
  }

  // ---- transitions (compare-and-set on the stage) --------------------------------------------------------------------------
  private async move(
    orgId: string,
    id: string,
    from: Stage[],
    to: Stage,
    p: {
      resume?: ResumeStage | null;
      code?: string | null;
      detail?: string | null;
      steps?: Record<string, unknown>;
      set?: Record<string, unknown>;
    } = {},
  ): Promise<Row | null> {
    const sets: string[] = [];
    const params: unknown[] = [
      id,
      from,
      to,
      p.resume ?? null,
      p.code ?? null,
      (p.detail ?? null)?.slice(0, 300) ?? null,
      JSON.stringify(p.steps ?? {}),
      this.now(),
    ];
    for (const [k, v] of Object.entries(p.set ?? {})) {
      if (!/^[a-z_]+$/.test(k)) throw new Error('bad column');
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
    return this.d.db.withOrg(orgId, async (c) => {
      const r = await c.query(
        `UPDATE compute.panel_installs SET stage = $3, stage_entered_at = $8, resume_stage = $4, attention_code = $5, attention_detail = $6, steps = steps || $7::jsonb,
                updated_at = now(), version = version + 1${sets.length ? ', ' + sets.join(', ') : ''}
          WHERE id = $1 AND stage = ANY($2::text[]) RETURNING *`,
        params,
      );
      return (r.rows[0] as Row | undefined) ?? null;
    });
  }
  private async attention(r: Row, code: string, detail: string | null, resume: ResumeStage) {
    const to = await this.move(
      r.org_id as string,
      r.id as string,
      [r.stage as Stage],
      'needs_attention',
      { resume, code, detail },
    );
    if (to)
      await this.d.audit.record({
        action: 'compute.panel_install.needs_attention',
        orgId: r.org_id as string,
        actorType: 'system',
        resource: { type: 'compute_instance', id: r.instance_id as string },
        outcome: 'failure',
        detail: { code, stage: r.stage },
      });
  }

  // ---- the driver ----------------------------------------------------------------------------------------------------------
  /** One idempotent step of the machine for one install. Safe to call any number of times, from the sweep, a callback or a retry. */
  async advance(installId: string): Promise<Stage | null> {
    let r = await this.byId(installId);
    if (!r) return null;
    const orgId = r.org_id as string;
    const cfg = this.d.config.get();
    const ageMs = this.now().getTime() - (r.stage_entered_at as Date).getTime();
    const stage = r.stage as Stage;
    if (stage === 'waiting_boot') {
      if (r.boot_seen_at) await this.move(orgId, installId, ['waiting_boot'], 'installing_panel');
      else if (cfg && ageMs > cfg.bootTimeoutMinutes * 60_000)
        await this.attention(
          r,
          'boot_timeout',
          'the server did not start the bootstrap in time',
          'waiting_boot',
        );
    } else if (stage === 'installing_panel') {
      const exp = r.registration_expires_at as Date | null;
      if (exp && exp.getTime() < this.now().getTime() && !r.registration_consumed_at)
        await this.attention(
          r,
          'registration_expired',
          'the registration window ended before the panel registered',
          'installing_panel',
        );
      else if (cfg && ageMs > cfg.installTimeoutMinutes * 60_000)
        await this.attention(
          r,
          'install_timeout',
          'the panel did not finish installing in time',
          'installing_panel',
        );
    } else if (stage === 'registering') await this.stepRegistering(r);
    else if (stage === 'readiness') await this.stepReadiness(r, cfg);
    else if (stage === 'ready') await this.checkLink(r);
    r = await this.byId(installId);
    return (r?.stage as Stage | undefined) ?? null;
  }

  private async stepRegistering(r: Row) {
    const reg = (
      r.steps as {
        register?: { tlsPin: string | null; panelVersion: string | null; keyRef: string };
      }
    ).register;
    if (!reg)
      return this.attention(
        r,
        'node_register_failed',
        'the registration data is missing',
        'registering',
      );
    const addrs = (r.server_addresses as string[]) ?? [];
    const dns = await this.d.dns.ensureARecords(r.panel_host as string, addrs);
    if (!dns.ok)
      return this.attention(
        r,
        dns.code === 'panel_dns_not_configured' ? 'panel_dns_not_configured' : 'dns_failed',
        null,
        'registering',
      );
    const inst = await this.d.db.withOrg(
      r.org_id as string,
      async (c) =>
        (
          await c.query(`SELECT name, data_region FROM compute.instances WHERE id = $1`, [
            r.instance_id,
          ])
        ).rows[0] as Row | undefined,
    );
    try {
      const node = await this.d.nodes.registerNode({
        orgId: r.org_id as string,
        instanceId: r.instance_id as string,
        name: `vps-${(r.instance_id as string).replace(/-/g, '').slice(-12)}`,
        region: r.provider_region_id as string,
        dataRegion: (inst?.data_region as string) ?? 'unknown',
        panelHost: r.panel_host as string,
        panelPort: Number(r.panel_port),
        tlsPinSha256: reg.tlsPin,
        keyRef: reg.keyRef,
        panelVersion: reg.panelVersion,
      });
      await this.move(r.org_id as string, r.id as string, ['registering'], 'readiness', {
        set: { panel_node_id: node.nodeId, attempts: 0 },
        steps: { register_done: { at: this.now().toISOString() } },
      });
    } catch {
      await this.attention(r, 'node_register_failed', null, 'registering');
    }
  }

  private async stepReadiness(r: Row, cfg: HestiaVpsConfig | null) {
    const nodeId = r.panel_node_id as string | null;
    if (!nodeId)
      return this.attention(r, 'node_register_failed', 'no panel connection', 'registering');
    const t: Awaited<ReturnType<PanelNodePort['check']>> = await this.d.nodes
      .check(nodeId)
      .catch(() => ({
        health: 'unknown' as const,
        panelVersion: null,
        profile: 'unknown' as const,
      }));
    const orgId = r.org_id as string;
    if (t.health === 'healthy' && t.profile === 'read_only') {
      const done = await this.move(orgId, r.id as string, ['readiness'], 'ready', {
        set: {
          ready_at: this.now(),
          panel_link: 'connected',
          panel_link_checked_at: this.now(),
          panel_version_seen: t.panelVersion,
        },
        steps: { readiness: { at: this.now().toISOString() } },
      });
      if (done)
        await this.d.audit.record({
          action: 'compute.panel_install.ready',
          orgId,
          actorType: 'system',
          resource: { type: 'compute_instance', id: r.instance_id as string },
          outcome: 'success',
          detail: { panelVersion: t.panelVersion },
        });
      return;
    }
    if (t.health === 'healthy' && t.profile === 'too_broad')
      return this.attention(
        r,
        'panel_permissions_too_broad',
        'the access key can run more than the read-only profile',
        'readiness',
      );
    const attempts = Number(r.attempts) + 1;
    if (cfg && attempts >= cfg.readinessAttempts)
      return this.attention(r, 'readiness_failed', t.code ?? null, 'readiness');
    await this.d.db.withOrg(orgId, (c) =>
      c.query(
        `UPDATE compute.panel_installs SET attempts = $2, updated_at = now() WHERE id = $1 AND stage = 'readiness'`,
        [r.id, attempts],
      ),
    );
  }

  /** After ready: the panel link can be lost (the customer has root and may break it) while the provider's start/stop/restart stay available. */
  private async checkLink(r: Row) {
    const last = r.panel_link_checked_at as Date | null;
    if (last && this.now().getTime() - last.getTime() < LINK_CHECK_MS) return;
    const nodeId = r.panel_node_id as string | null;
    if (!nodeId) return;
    const t = await this.d.nodes.check(nodeId).catch(() => null);
    const link: 'connected' | 'lost' = t && t.health === 'healthy' ? 'connected' : 'lost';
    await this.d.db.withOrg(r.org_id as string, async (c) => {
      await c.query(
        `UPDATE compute.panel_installs SET panel_link = $2, panel_link_checked_at = $3, updated_at = now() WHERE id = $1 AND stage = 'ready'`,
        [r.id, link, this.now()],
      );
      if (link !== r.panel_link)
        await this.d.audit.record({
          action: 'compute.panel_link.changed',
          orgId: r.org_id as string,
          actorType: 'system',
          resource: { type: 'compute_instance', id: r.instance_id as string },
          outcome: link === 'connected' ? 'success' : 'failure',
          detail: { link },
        });
    });
  }

  /** The periodic sweep (also catches installs whose kick was lost). */
  async sweep(): Promise<number> {
    const ids = await this.d.db.withPlatformScope(async (c) =>
      (
        await c.query(
          `SELECT id FROM compute.panel_installs WHERE stage IN ('waiting_boot','installing_panel','registering','readiness','ready') ORDER BY updated_at LIMIT 200`,
        )
      ).rows.map((x) => x.id as string),
    );
    for (const id of ids)
      await this.advance(id).catch((e) =>
        console.error(JSON.stringify({ panel_install_error: (e as Error).message })),
      );
    return ids.length;
  }

  // ---- the server's callbacks (authenticated by the registration secret only) -----------------------------------------------
  private async authenticate(header: string | undefined): Promise<Row> {
    const tok = parseRegistrationToken(header);
    if (!tok) throw new ProblemException('unauthenticated', 'registration secret required');
    const r = await this.d.db.withPlatformScope(
      async (c) =>
        (
          await c.query(`SELECT * FROM compute.panel_installs WHERE registration_id = $1`, [
            tok.registrationId,
          ])
        ).rows[0] as Row | undefined,
    );
    if (!r || !secretMatches(tok.secret, r.registration_hash as string))
      throw new ProblemException('unauthenticated', 'registration secret is not valid');
    const exp = r.registration_expires_at as Date | null;
    if (!exp)
      throw new ProblemException(
        'conflict',
        'the server is not registered with the platform yet; retry shortly',
      );
    if (exp.getTime() < this.now().getTime())
      throw new ProblemException('gone', 'the registration window has ended');
    return r;
  }

  async handleEvent(header: string | undefined, body: unknown): Promise<void> {
    const r = await this.authenticate(header);
    const b = (body ?? {}) as { phase?: unknown; code?: unknown };
    const phases = ['booted', 'installer_verified', 'installing', 'failed', 'note'];
    if (typeof b.phase !== 'string' || !phases.includes(b.phase))
      throw new ProblemException('validation_failed', 'phase is invalid');
    const code = typeof b.code === 'string' && /^[a-z0-9_]{0,60}$/.test(b.code) ? b.code : '';
    const orgId = r.org_id as string;
    const at = this.now();
    if (r.registration_consumed_at) return; // a late duplicate after registration: nothing left to say
    const stageOk = [
      'create_server',
      'waiting_boot',
      'installing_panel',
      'needs_attention',
    ].includes(r.stage as string);
    if (!stageOk) return;
    if (b.phase === 'failed') {
      const attn = `bootstrap_${code || 'failed'}`;
      await this.attention(
        r,
        attn === 'bootstrap_integrity_failed' ? 'integrity_failed' : attn,
        null,
        'installing_panel',
      );
      return;
    }
    await this.d.db.withOrg(orgId, async (c) => {
      await c.query(
        `UPDATE compute.panel_installs SET last_event_at = $2, boot_seen_at = COALESCE(boot_seen_at, CASE WHEN $3 = 'booted' THEN $2::timestamptz END),
                steps = steps || jsonb_build_object($3::text, jsonb_build_object('at', $2::text, 'code', $4::text)), updated_at = now() WHERE id = $1`,
        [r.id, at, b.phase, code],
      );
    });
    if (b.phase === 'booted')
      await this.move(orgId, r.id as string, ['waiting_boot'], 'installing_panel', {}).catch(
        () => null,
      );
  }

  /** The registration: single use, bound to this order/instance/server, address-checked against the provider, then sealed and handed to the node registry. */
  async handleRegister(
    header: string | undefined,
    body: unknown,
    sourceIp: string,
  ): Promise<{ status: 'registered' | 'already_registered' }> {
    const r = await this.authenticate(header);
    const b = (body ?? {}) as Record<string, unknown>;
    const accessKey = b.accessKey;
    if (
      typeof accessKey !== 'string' ||
      !/^[A-Za-z0-9]{8,64}:[A-Za-z0-9._-]{8,128}$/.test(accessKey)
    )
      throw new ProblemException('validation_failed', 'accessKey is invalid');
    if (typeof b.host !== 'string' || b.host !== r.panel_host)
      throw new ProblemException('validation_failed', 'host does not match the order');
    if (b.port !== Number(r.panel_port))
      throw new ProblemException('validation_failed', 'port does not match the order');
    const pin =
      typeof b.tlsFingerprintSha256 === 'string' &&
      /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(b.tlsFingerprintSha256.toUpperCase())
        ? b.tlsFingerprintSha256.toUpperCase()
        : null;
    if (!pin) throw new ProblemException('validation_failed', 'tlsFingerprintSha256 is invalid');
    const version =
      typeof b.panelVersion === 'string' && /^[0-9]{1,3}(\.[0-9]{1,3}){1,3}$/.test(b.panelVersion)
        ? b.panelVersion
        : null;
    const ip = sourceIp.replace(/^::ffff:/, '');
    const fp = hashSecret(accessKey);
    const orgId = r.org_id as string;

    if (r.registration_consumed_at) {
      // the answer may have been lost: the same server repeating the same registration is accepted once more, anything else is refused
      const reg = (r.steps as { register?: { keyFp?: string } }).register;
      if (reg?.keyFp === fp && r.registration_source_ip === ip)
        return { status: 'already_registered' };
      throw new ProblemException('conflict', 'this registration was already used');
    }
    if (!['installing_panel', 'waiting_boot', 'needs_attention'].includes(r.stage as string))
      throw new ProblemException('invalid_state', 'the install is not waiting for a registration');

    // identity and address: the provider's own record of THIS server must show it running in the sold region, carrying our instance tag when the provider has tags,
    // and the request must come from one of its public addresses.
    const acc = await this.d.prov.access(
      (await this.accountOf(orgId, r.instance_id as string)) ?? '',
      `panel-${r.id as string}`,
    );
    const ref = r.server_ref as string | null;
    if (!acc || !ref)
      throw new ProblemException('service_unavailable', 'the server cannot be verified right now');
    const ins = await acc.adapter.inspect(acc.ctx, ref);
    if (ins.status !== 'succeeded' || !ins.data)
      throw new ProblemException(
        'service_unavailable',
        'the provider could not confirm the server right now',
      );
    const tag = ins.data.tags['nuzm-instance'];
    const identityOk =
      ins.data.status === 'running' &&
      ins.data.providerRegionId === r.provider_region_id &&
      (tag === undefined || tag === r.instance_id);
    const addrs = ins.data.publicIps.map((x) => x.replace(/^::ffff:/, ''));
    if (!identityOk || !addrs.includes(ip)) {
      await this.d.audit.record({
        action: 'compute.panel_registration.rejected',
        orgId,
        actorType: 'system',
        resource: { type: 'compute_instance', id: r.instance_id as string },
        outcome: 'failure',
        detail: { identityOk, addressMatch: addrs.includes(ip) },
      });
      throw new ProblemException(
        'forbidden',
        'the registration does not come from the server this order created',
      );
    }
    if (!this.d.vault || process.env.NODE_ENV === 'production') {
      await this.attention(
        r,
        'vault_unavailable',
        'the production secret store is not decided yet (D-12)',
        'registering',
      );
      throw new ProblemException('service_unavailable', 'the secret store is not available');
    }
    const keyRef = await this.d.vault.putFields(`hosting-panel-vps-${r.id as string}`, {
      accessKey,
    });
    // consume: atomic and single use. Two concurrent registrations: exactly one passes.
    const won = await this.d.db.withOrg(orgId, async (c) => {
      const u = await c.query(
        `UPDATE compute.panel_installs SET registration_consumed_at = now(), registration_source_ip = $2, stage = 'registering', stage_entered_at = now(), resume_stage = NULL,
                attention_code = NULL, attention_detail = NULL, server_addresses = $3, steps = steps || $4::jsonb, updated_at = now(), version = version + 1
          WHERE id = $1 AND registration_consumed_at IS NULL AND registration_expires_at > now()
            AND stage IN ('installing_panel','waiting_boot','needs_attention') RETURNING id`,
        [
          r.id,
          ip,
          JSON.stringify(addrs),
          JSON.stringify({
            register: {
              tlsPin: pin,
              panelVersion: version,
              keyRef,
              keyFp: fp,
              at: this.now().toISOString(),
            },
          }),
        ],
      );
      return u.rowCount === 1;
    });
    if (!won) throw new ProblemException('conflict', 'this registration was already used');
    if (r.registration_secret_ref && this.d.vault)
      await this.d.vault.delete(r.registration_secret_ref as string);
    await this.d.audit.record({
      action: 'compute.panel_registration.accepted',
      orgId,
      actorType: 'system',
      resource: { type: 'compute_instance', id: r.instance_id as string },
      outcome: 'success',
    });
    void this.advance(r.id as string).catch(() => undefined);
    return { status: 'registered' };
  }

  private async accountOf(orgId: string, instanceId: string): Promise<string | null> {
    const x = await this.d.db.withOrg(
      orgId,
      async (c) =>
        (
          await c.query(
            `SELECT r.provider_account_id FROM compute.instances i JOIN cloud.resources r ON r.id = i.resource_id WHERE i.id = $1`,
            [instanceId],
          )
        ).rows[0] as Row | undefined,
    );
    return (x?.provider_account_id as string | undefined) ?? null;
  }

  // ---- resume ---------------------------------------------------------------------------------------------------------------
  /**
   * Resume an install that needs attention WITHOUT creating, replacing or wiping anything:
   *  - Nuzm-side causes (readiness, DNS, node registration, vault): the machine continues from its stage;
   *  - the bootstrap did not finish on the server: the registration window is extended (same secret, same order, same server) and the caller is told to re-run the script that is still on the server;
   *  - `integrity_failed` (the pinned digest did not match) is never retried on that server: the user data cannot change, and nothing unverified runs.
   */
  async retry(
    orgId: string,
    instanceId: string,
    actorUserId: string,
  ): Promise<{ action: 'continued' | 'rerun_bootstrap'; command?: string; panel: PanelDto }> {
    const r = await this.row(orgId, instanceId);
    if (!r) throw new ProblemException('not_found', 'this server has no panel install');
    if (r.stage !== 'needs_attention' || !r.attention_code)
      throw new ProblemException('invalid_state', 'nothing needs attention on this install');
    const code = r.attention_code as string;
    const resume = (r.resume_stage as ResumeStage | null) ?? 'create_server';
    let action: 'continued' | 'rerun_bootstrap' = 'continued';
    if (NUZM_SIDE.has(code)) {
      await this.move(orgId, r.id as string, ['needs_attention'], resume, { set: { attempts: 0 } });
    } else if (SERVER_SIDE.has(code)) {
      if (r.registration_consumed_at)
        throw new ProblemException('invalid_state', 'the server already registered');
      const cfg = this.d.config.get();
      await this.move(orgId, r.id as string, ['needs_attention'], 'installing_panel', {
        set: {
          registration_expires_at: new Date(
            this.now().getTime() + (cfg?.registrationTtlMinutes ?? 180) * 60_000,
          ),
          attempts: Number(r.attempts) + 1,
        },
      });
      action = 'rerun_bootstrap';
    } else {
      throw new ProblemException(
        'invalid_state',
        'this problem cannot be resumed on this server; contact support',
      );
    }
    await this.d.audit.record({
      action: 'compute.panel_install.resumed',
      actorUserId,
      orgId,
      resource: { type: 'compute_instance', id: instanceId },
      outcome: 'success',
      detail: { code, action },
    });
    void this.advance(r.id as string).catch(() => undefined);
    const panel = (await this.status(orgId, instanceId))!;
    return { action, ...(action === 'rerun_bootstrap' ? { command: RERUN_COMMAND } : {}), panel };
  }
}

export { pgCode };
