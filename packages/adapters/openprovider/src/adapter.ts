import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AdapterTimeoutError,
  CONTRACT_VERSION,
  Redactor,
  WebhookRejectedError,
  completeCapabilities,
  isVaultRef,
  normalizedError,
  toMinorUnits,
  type AccountContext,
  type AuthCodeStore,
  type AvailabilityResult,
  type CapabilityState,
  type ContactPayload,
  type ContactSet,
  type DnsCapability,
  type DnsChange,
  type DnsChangeResult,
  type DnsChangeSetOutcome,
  type DnsRecordData,
  type DnsZoneState,
  type DomainRef,
  type ErrorCategory,
  type EvidenceKind,
  type HealthReport,
  type HttpClient,
  type NormalizedError,
  type OperationResult,
  type ProviderCostRecord,
  type ProviderDomainState,
  type RawEvidence,
  type RegisterRequest,
  type RegistrarAdapter,
  type RegistrarCapabilityId,
  type RegistrarCapabilityReport,
  type RenewRequest,
  type TldCatalogSnapshot,
  type TldSupport,
  type TransferInRequest,
  type VaultClient,
  type VerifiedEvent,
  type VerifiedEventKind,
} from '@nuzm/registrar-contracts';

/**
 * Openprovider RegistrarAdapter. Built ONLY from docs/adapters/openprovider.md (retrieved 2026-11-18); every operation not documented there is
 * `unsupported`. NOT VERIFIED against any real or sandbox account (HG-07-01): the only evidence it can produce is `fixture`/`mock`.
 * Vendor has no client token, so the registration token travels in the domain `comments` field and `findByToken` searches it (docs §3.4).
 */
export const OPENPROVIDER_PRODUCTION_URL = 'https://api.openprovider.eu/v1';
export const OPENPROVIDER_SANDBOX_URL = 'https://api.sandbox.openprovider.nl/v1beta';
export const OPENPROVIDER_HOSTS = ['api.openprovider.eu', 'api.sandbox.openprovider.nl'] as const;

export interface OpenproviderOptions {
  baseUrl: string;
  http: HttpClient;
  vault: VaultClient;
  /** What the evidence of this run is: `mock` (local mock server), `fixture` (recorded replay) or `live` (only after HG-07-01). */
  evidenceKind: EvidenceKind;
  now?: () => Date;
  /** Default deadline when the context carries none. */
  defaultDeadlineMs?: number;
}

interface Envelope {
  code: number;
  desc?: string;
  data?: unknown;
  maintenance?: boolean;
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

const COMMENT_PREFIX = 'nuzm:';
export const commentFor = (token: string): string => `${COMMENT_PREFIX}${token}`;

/** Error codes of the vendor's error page (docs §4) mapped to our categories. Anything else is `unknown` (never retried blindly). */
function classify(code: number): { category: ErrorCategory; retryable: boolean } {
  if ([196, 190, 900, 901, 902, 10004, 10006, 10007, 197, 4002, 10008, 10009, 4004].includes(code))
    return { category: 'auth', retryable: false };
  if (code === 10005) return { category: 'rate_limit', retryable: true };
  if ([50, 4007, 342].includes(code)) return { category: 'rate_limit', retryable: true };
  if ([4005, 340, 10, 17, 3005, 3006].includes(code))
    return { category: 'provider_outage', retryable: true };
  if ([310, 920].includes(code)) return { category: 'quota', retryable: false };
  if ([311, 326, 346, 350, 362, 327, 512, 513, 16, 514].includes(code))
    return { category: 'conflict', retryable: false };
  if ([318, 328, 322, 19004, 542].includes(code))
    return { category: 'validation', retryable: false };
  if (
    [80, 81, 104, 315, 316, 347, 701, 1, 19013].includes(code) ||
    (code >= 122 && code <= 195) ||
    (code >= 220 && code <= 247) ||
    (code >= 800 && code <= 877) ||
    (code >= 330 && code <= 335)
  )
    return { category: 'validation', retryable: false };
  return { category: 'unknown', retryable: false };
}

const STATE: Record<string, ProviderDomainState> = {
  ACT: 'active',
  REQ: 'pending',
  FAI: 'failed',
  DEL: 'expired',
};
const splitName = (name: string): { name: string; extension: string } => {
  const i = name.indexOf('.');
  return { name: name.slice(0, i), extension: name.slice(i + 1) };
};

export class OpenproviderAdapter implements RegistrarAdapter {
  readonly id = 'openprovider';
  readonly providerCode = 'openprovider';
  readonly kind = 'registrar' as const;
  readonly contractVersion = CONTRACT_VERSION;
  private readonly tokens = new Map<string, { token: string; at: number }>();
  readonly dns: DnsCapability;

  constructor(private readonly o: OpenproviderOptions) {
    this.dns = new OpenproviderDns(this);
  }

  // ---- plumbing --------------------------------------------------------------------------------------------------------------
  now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  evidence(
    operation: string,
    summary: string,
    redactedRequest?: unknown,
    redactedResponse?: unknown,
  ): RawEvidence {
    return {
      kind: this.o.evidenceKind,
      capturedAt: this.now(),
      operation,
      summary,
      redactedRequest,
      redactedResponse,
    };
  }
  private async creds(ctx: AccountContext) {
    if (!isVaultRef(ctx.credentialRef))
      throw new Error('credentialRef must be a vault:// reference');
    const m = await this.o.vault.resolve(ctx.credentialRef);
    return { material: m, username: m.fields.username ?? '', password: m.fields.password ?? '' };
  }
  private redactor(extra: string[] = []): Redactor {
    return new Redactor().register(extra);
  }

  /**
   * One vendor call. Resolves/refreshes the bearer token (48 h, re-login on 196). Returns the parsed envelope or a normalized failure. A transport timeout or a
   * dropped connection on a MUTATING call is `uncertain` (the vendor may have acted); on a read it is a retryable outage.
   */
  async call(
    ctx: AccountContext,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    opts: { mutating: boolean; op: string; auth?: boolean },
  ): Promise<
    | { ok: true; data: unknown; ev: RawEvidence }
    | { ok: false; status: 'failed' | 'uncertain'; error: NormalizedError; ev: RawEvidence }
  > {
    const c = await this.creds(ctx);
    const red = this.redactor(Object.values(c.material.fields));
    const fail = (status: 'failed' | 'uncertain', error: NormalizedError) => ({
      ok: false as const,
      status,
      error,
      ev: this.evidence(opts.op, red.string(error.message), undefined, {
        code: error.providerCode,
      }),
    });
    const send = async (token: string | null) => {
      const res = await this.o.http.request({
        method,
        url: `${this.o.baseUrl}${path}`,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        deadlineMs: ctx.deadlineMs,
      });
      return res;
    };
    try {
      let token: string | null = null;
      if (opts.auth !== false) {
        const cached = this.tokens.get(ctx.providerAccountId);
        token =
          cached && Date.now() - cached.at < 40 * 3600_000
            ? cached.token
            : await this.login(ctx, c.username, c.password);
      }
      let res = await send(token);
      let env = this.parse(res.text);
      if (env && env.code === 196 && opts.auth !== false) {
        this.tokens.delete(ctx.providerAccountId);
        token = await this.login(ctx, c.username, c.password);
        res = await send(token);
        env = this.parse(res.text);
      }
      if (!env) {
        // non-JSON or empty body (5xx proxy page): the outcome is unknown for a mutation, an outage for a read
        const e = normalizedError(
          'provider_outage',
          `http_${res.status}`,
          'the registrar returned an unreadable answer',
          true,
        );
        return fail(opts.mutating ? 'uncertain' : 'failed', e);
      }
      if (env.code !== 0) {
        const k = classify(env.code);
        const e = normalizedError(
          k.category,
          String(env.code),
          red.string(env.desc ?? 'registrar error'),
          k.retryable,
        );
        // the vendor refused the request: a definitive answer, except a maintenance window where nothing was processed either
        return fail('failed', e);
      }
      return {
        ok: true,
        data: env.data,
        ev: this.evidence(opts.op, `${method} ${path} ok`, { method, path }, { code: 0 }),
      };
    } catch (e) {
      if (
        e instanceof AdapterTimeoutError ||
        (e as Error).name === 'AdapterTimeoutError' ||
        (e as Error).name === 'TypeError' ||
        (e as Error).message === 'fetch failed'
      )
        return fail(
          opts.mutating ? 'uncertain' : 'failed',
          normalizedError(
            'provider_outage',
            'timeout',
            'the registrar did not answer in time',
            true,
          ),
        );
      throw e;
    }
  }
  private parse(text: string): Envelope | null {
    try {
      const j = JSON.parse(text) as unknown;
      return j && typeof j === 'object' && typeof (j as Envelope).code === 'number'
        ? (j as Envelope)
        : null;
    } catch {
      return null;
    }
  }
  private async login(ctx: AccountContext, username: string, password: string): Promise<string> {
    const res = await this.o.http.request({
      method: 'POST',
      url: `${this.o.baseUrl}/auth/login`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password, ip: '0.0.0.0' }),
      deadlineMs: ctx.deadlineMs,
    });
    const env = this.parse(res.text);
    const token = str(obj(env?.data).token);
    if (!env || env.code !== 0 || !token) {
      const k = classify(env?.code ?? -1);
      throw new LoginError(
        normalizedError(
          env && env.code !== 0 ? k.category : 'provider_outage',
          String(env?.code ?? 'http'),
          'login to the registrar failed',
          k.retryable,
        ),
      );
    }
    this.tokens.set(ctx.providerAccountId, { token, at: Date.now() });
    return token;
  }
  /** Public wrapper that turns a LoginError into a failed result. */
  async safe<T>(
    ctx: AccountContext,
    op: string,
    mutating: boolean,
    fn: () => Promise<OperationResult<T>>,
  ): Promise<OperationResult<T>> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof LoginError)
        return {
          status: 'failed',
          error: e.error,
          raw: this.evidence(op, 'login failed', undefined, { code: e.error.providerCode }),
        };
      void mutating;
      throw e;
    }
  }

  // ---- probe / health / catalogue -----------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext): Promise<RegistrarCapabilityReport> {
    const caps: Partial<Record<RegistrarCapabilityId, CapabilityState>> = {};
    const ev: RawEvidence[] = [];
    const tlds = await this.call(ctx, 'GET', '/tlds?limit=1&status=ACT', undefined, {
      mutating: false,
      op: 'probe.tlds',
    });
    ev.push(tlds.ev);
    const state = (ok: boolean): CapabilityState => (ok ? 'supported' : 'unsupported');
    if (!tlds.ok) {
      // an unreachable or unauthorized account proves nothing: every capability stays unknown
      return { capabilities: completeCapabilities({}), evidence: ev, probedAt: this.now() };
    }
    const check = await this.call(
      ctx,
      'POST',
      '/domains/check',
      { domains: [{ name: 'nuzm-probe', extension: 'com' }], with_price: false },
      { mutating: false, op: 'probe.check' },
    );
    ev.push(check.ev);
    caps['registrar.search'] = state(check.ok);
    // register/renew/transfer cannot be proven without a side effect: they follow the TLD catalogue (docs §3.2 "no register_available flag")
    const catalogue = obj(tlds.data);
    const anyTld = arr(catalogue.results).length > 0;
    caps['registrar.register'] = anyTld && check.ok ? 'supported' : 'unknown';
    caps['registrar.renew'] = caps['registrar.register'];
    caps['registrar.transfer-in'] = caps['registrar.register'];
    caps['registrar.contacts'] = caps['registrar.register'];
    caps['registrar.nameservers'] = caps['registrar.register'];
    caps['registrar.lock'] = caps['registrar.register'];
    caps['registrar.privacy'] = caps['registrar.register'];
    caps['registrar.auth-code'] = caps['registrar.register'];
    caps['registrar.find-by-token'] = caps['registrar.register']; // documented lookup: comments + search (docs §3.4)
    const zones = await this.call(ctx, 'GET', '/dns/zones?limit=1', undefined, {
      mutating: false,
      op: 'probe.dns',
    });
    ev.push(zones.ev);
    caps['registrar.dns'] = state(zones.ok);
    const tx = await this.call(ctx, 'GET', '/transactions?limit=1', undefined, {
      mutating: false,
      op: 'probe.billing',
    });
    ev.push(tx.ev);
    caps['registrar.billing-export'] = state(tx.ok);
    caps['registrar.dnssec'] = 'unknown'; // zone-level DNSSEC is NOT DOCUMENTED (docs §3.10)
    caps['registrar.webhooks'] = 'unknown'; // settings field names NOT DOCUMENTED (docs §3.12)
    caps['registrar.eligibility'] = 'unsupported'; // structured eligibility rules NOT DOCUMENTED (docs §3.2)
    return { capabilities: completeCapabilities(caps), evidence: ev, probedAt: this.now() };
  }

  async health(ctx: AccountContext): Promise<HealthReport> {
    const t0 = Date.now();
    const r = await this.safe(ctx, 'health', false, async () => {
      const x = await this.call(ctx, 'GET', '/tlds?limit=1', undefined, {
        mutating: false,
        op: 'health',
      });
      return x.ok
        ? { status: 'succeeded' as const, raw: x.ev }
        : { status: 'failed' as const, error: x.error, raw: x.ev };
    });
    const state =
      r.status === 'succeeded'
        ? 'healthy'
        : r.error?.category === 'provider_outage'
          ? 'unhealthy'
          : r.error?.category === 'auth'
            ? 'degraded'
            : 'unknown';
    return {
      state,
      checkedAt: this.now(),
      latencyMs: Date.now() - t0,
      detail: r.error?.providerCode,
      evidence: [r.raw],
    };
  }

  async catalog(ctx: AccountContext): Promise<TldCatalogSnapshot> {
    const tlds = await this.supportedTlds(ctx);
    return {
      takenAt: this.now(),
      tlds,
      evidence: [this.evidence('catalog', `${tlds.length} TLDs`)],
    };
  }

  async supportedTlds(ctx: AccountContext): Promise<TldSupport[]> {
    const r = await this.safe(ctx, 'tlds', false, async () => {
      const x = await this.call(
        ctx,
        'GET',
        '/tlds?status=ACT&with_price=true&with_restrictions=true&limit=1000',
        undefined,
        { mutating: false, op: 'tlds' },
      );
      return x.ok
        ? { status: 'succeeded' as const, data: x.data, raw: x.ev }
        : { status: 'failed' as const, error: x.error, raw: x.ev };
    });
    if (r.status !== 'succeeded') return [];
    return arr(obj(r.data).results).map((t) => {
      const prices = obj(t.prices);
      const money = (
        v: unknown,
        cur: unknown,
      ): { amountMinor: string; currency: string } | null => {
        const currency = typeof cur === 'string' ? cur : 'EUR';
        const m = toMinorUnits(v, currency);
        return m === null ? null : { amountMinor: m, currency };
      };
      const cur =
        obj(prices.reseller_price).currency ?? obj(prices.create_price).currency ?? prices.currency;
      const restrictions = Array.isArray(t.restrictions) ? (t.restrictions as unknown[]) : [];
      const flag = (v: unknown): CapabilityState =>
        v === true ? 'supported' : v === false ? 'unsupported' : 'unknown';
      const price = (k: string) => {
        const p = prices[k];
        return money(
          typeof p === 'object' ? obj(p).price : p,
          typeof p === 'object' ? obj(p).currency : cur,
        );
      };
      return {
        tld: String(t.name),
        register: t.status === 'ACT' ? 'supported' : 'unsupported',
        transfer: flag(t.transfer_available),
        renew: flag(t.renew_available),
        dns: 'unknown',
        privacy: flag(t.is_private_whois_allowed),
        dnssec: flag(t.dnssec_allowed),
        eligibilityRules: restrictions.length > 0 ? 'registry' : 'unknown',
        restricted: restrictions.length > 0,
        minYears: Number(t.min_period ?? 1),
        maxYears: Number(t.max_period ?? 10),
        requiredContactFields: [],
        prices: {
          register: price('create_price'),
          renew: price('renew_price'),
          transfer: price('transfer_price'),
        },
      } satisfies TldSupport;
    });
  }

  // ---- search -----------------------------------------------------------------------------------------------------------------
  async search(
    ctx: AccountContext,
    names: string[],
    tlds: string[],
  ): Promise<AvailabilityResult[]> {
    const pairs = names.flatMap((n) => tlds.map((t) => ({ name: n, extension: t })));
    const out: AvailabilityResult[] = [];
    for (let i = 0; i < pairs.length; i += 15) {
      // error 701: at most 15 domains per check call
      const chunk = pairs.slice(i, i + 15);
      const r = await this.call(
        ctx,
        'POST',
        '/domains/check',
        { domains: chunk, with_price: true, with_whois: false },
        { mutating: false, op: 'search' },
      );
      if (!r.ok) {
        for (const p of chunk) out.push(this.unknownResult(p));
        continue;
      }
      const results = arr(obj(r.data).results);
      for (const p of chunk) {
        const full = `${p.name}.${p.extension}`;
        const x = results.find((y) => y.domain === full);
        if (!x) {
          out.push(this.unknownResult(p));
          continue;
        }
        const premium = obj(x.premium);
        const priceObj = obj(obj(x.price).reseller);
        const premiumPrice = obj(premium.price);
        const currency = String(premium.currency ?? priceObj.currency ?? 'EUR');
        const create =
          x.is_premium === true
            ? toMinorUnits(premiumPrice.create, currency)
            : toMinorUnits(priceObj.price, String(priceObj.currency ?? currency));
        out.push({
          name: full,
          tld: p.extension,
          available:
            x.status === 'free'
              ? true
              : x.status === 'active' || x.status === 'reserved' || x.status === 'in use'
                ? false
                : 'unknown',
          premium: x.is_premium === true,
          registerPrice:
            create === null
              ? null
              : {
                  amountMinor: create,
                  currency: String(
                    x.is_premium === true ? currency : (priceObj.currency ?? currency),
                  ),
                },
          renewPrice:
            x.is_premium === true
              ? toMinorUnits(premiumPrice.renew, currency) === null
                ? null
                : { amountMinor: toMinorUnits(premiumPrice.renew, currency)!, currency }
              : null,
          transferPrice: null,
          cacheTtlSeconds: 60,
          observedAt: this.now(),
        });
      }
    }
    return out;
  }
  private unknownResult(p: { name: string; extension: string }): AvailabilityResult {
    return {
      name: `${p.name}.${p.extension}`,
      tld: p.extension,
      available: 'unknown',
      premium: false,
      registerPrice: null,
      renewPrice: null,
      transferPrice: null,
      cacheTtlSeconds: 0,
      observedAt: this.now(),
    };
  }

  // ---- mapping ----------------------------------------------------------------------------------------------------------------
  toRef(d: Obj): DomainRef {
    const dom = obj(d.domain);
    const name =
      str(d.full_name) ??
      (dom.name && dom.extension ? `${String(dom.name)}.${String(dom.extension)}` : '');
    const ns = arr(d.name_servers)
      .map((n) => String(n.name))
      .filter(Boolean);
    return {
      providerRef: String(d.id),
      name,
      state: STATE[String(d.status)] ?? 'unknown',
      expiresAt: str(d.renewal_date) ?? str(d.expiration_date),
      nameservers: ns,
      locked: typeof d.is_locked === 'boolean' ? d.is_locked : null,
      autoRenew: d.autorenew === 'on' ? true : d.autorenew === 'off' ? false : null,
      privacy:
        d.is_private_whois_allowed === false
          ? 'unsupported'
          : d.is_private_whois_enabled === true
            ? 'on'
            : d.is_private_whois_enabled === false
              ? 'off'
              : null,
    };
  }
  private async findDomain(
    ctx: AccountContext,
    query: string,
  ): Promise<
    | { ok: true; items: Obj[] }
    | { ok: false; status: 'failed' | 'uncertain'; error: NormalizedError; ev: RawEvidence }
  > {
    const r = await this.call(ctx, 'GET', `/domains?${query}&limit=10`, undefined, {
      mutating: false,
      op: 'domains.search',
    });
    if (!r.ok) return r;
    return { ok: true, items: arr(obj(r.data).results) };
  }

  /** Creates the vendor-side contact handles for a contact set. Identical payloads share a handle. PII leaves only in this request. */
  private async handles(
    ctx: AccountContext,
    contacts: ContactSet,
  ): Promise<
    | { ok: true; h: Record<string, string> }
    | { ok: false; status: 'failed' | 'uncertain'; error: NormalizedError; ev: RawEvidence }
  > {
    const byKey = new Map<string, string>();
    const h: Record<string, string> = {};
    for (const role of ['registrant', 'admin', 'tech', 'billing'] as const) {
      const c = contacts[role];
      const key = JSON.stringify(c);
      let handle = byKey.get(key);
      if (!handle) {
        const r = await this.call(ctx, 'POST', '/customers', this.customerBody(c), {
          mutating: true,
          op: 'customers.create',
        });
        if (!r.ok) return r;
        handle = String(obj(r.data).handle);
        byKey.set(key, handle);
      }
      h[role] = handle;
    }
    return { ok: true, h };
  }
  private customerBody(c: ContactPayload): Obj {
    const m = /^\+(\d{1,3})(\d+)$/.exec(c.phone);
    return {
      name: { first_name: c.firstName, last_name: c.lastName },
      ...(c.organization ? { company_name: c.organization } : {}),
      address: {
        street: c.address.street,
        number: '0',
        zipcode: c.address.postalCode,
        city: c.address.city,
        ...(c.address.state ? { state: c.address.state } : {}),
        country: c.address.country,
      },
      phone: {
        country_code: m ? `+${m[1]}` : '+0',
        area_code: '',
        subscriber_number: m ? m[2] : c.phone,
      },
      email: c.email,
      ...(c.extra ? { extension_additional_data: [{ name: 'extra', data: c.extra }] } : {}),
    };
  }

  private result<T>(
    op: string,
    r: { ok: false; status: 'failed' | 'uncertain'; error: NormalizedError; ev: RawEvidence },
  ): OperationResult<T> {
    void op;
    return { status: r.status, error: r.error, raw: r.ev };
  }

  // ---- register / transfer / renew ----------------------------------------------------------------------------------------------
  async findByToken(
    ctx: AccountContext,
    token: string,
    hint: { name: string },
  ): Promise<OperationResult<DomainRef | null>> {
    return this.safe(ctx, 'findByToken', false, async () => {
      const byComment = await this.findDomain(
        ctx,
        `comment_pattern=${encodeURIComponent(commentFor(token))}&with_additional_data=false`,
      );
      if (!byComment.ok) return { status: 'uncertain', error: byComment.error, raw: byComment.ev };
      const hit = byComment.items.find((d) => d.comments === commentFor(token));
      if (hit)
        return {
          status: 'succeeded',
          data: this.toRef(hit),
          providerRef: String(hit.id),
          raw: this.evidence('findByToken', 'found by reference'),
        };
      // Absence is only provable when the name lookup is clean too: a REQ record or a domain with another reference is reported accurately
      const byName = await this.findDomain(ctx, `full_name=${encodeURIComponent(hint.name)}`);
      if (!byName.ok) return { status: 'uncertain', error: byName.error, raw: byName.ev };
      const other = byName.items.find((d) => this.toRef(d).name === hint.name);
      if (other && other.comments === commentFor(token))
        return {
          status: 'succeeded',
          data: this.toRef(other),
          raw: this.evidence('findByToken', 'found by name'),
        };
      return {
        status: 'succeeded',
        data: null,
        raw: this.evidence('findByToken', 'absent: no domain carries this reference'),
      };
    });
  }

  async inspect(ctx: AccountContext, name: string): Promise<OperationResult<DomainRef | null>> {
    return this.safe(ctx, 'inspect', false, async () => {
      const r = await this.findDomain(ctx, `full_name=${encodeURIComponent(name)}`);
      if (!r.ok)
        return {
          status: r.status === 'uncertain' ? 'failed' : r.status,
          error: r.error,
          raw: r.ev,
        };
      const d = r.items.find((x) => this.toRef(x).name === name);
      return {
        status: 'succeeded',
        data: d ? this.toRef(d) : null,
        raw: this.evidence('inspect', d ? 'found' : 'absent'),
      };
    });
  }

  async register(ctx: AccountContext, req: RegisterRequest): Promise<OperationResult<DomainRef>> {
    return this.safe(ctx, 'register', true, async () => {
      // adapter-level idempotency: the vendor has no client token, so look for THIS attempt's reference first
      const prior = await this.findByToken(ctx, req.idempotencyToken, { name: req.name });
      if (prior.status === 'succeeded' && prior.data)
        return {
          status: prior.data.state === 'pending' ? 'accepted' : 'succeeded',
          providerRef: prior.data.providerRef,
          data: prior.data,
          raw: this.evidence('register', 'already registered under this reference'),
        };
      if (prior.status !== 'succeeded')
        return { status: 'uncertain', error: prior.error, raw: prior.raw };
      const h = await this.handles(ctx, req.contacts);
      if (!h.ok) return this.result('register', h);
      const dom = splitName(req.name);
      const r = await this.call(
        ctx,
        'POST',
        '/domains',
        {
          domain: dom,
          period: req.years,
          owner_handle: h.h.registrant,
          admin_handle: h.h.admin,
          tech_handle: h.h.tech,
          billing_handle: h.h.billing,
          ...(req.nameservers?.length
            ? { name_servers: req.nameservers.map((n) => ({ name: n })) }
            : { ns_group: 'dns-openprovider' }),
          autorenew: req.autoRenew ? 'on' : 'off',
          is_private_whois_enabled: req.privacy,
          comments: commentFor(req.idempotencyToken),
        },
        { mutating: true, op: 'register' },
      );
      if (!r.ok) return this.result('register', r);
      const d = obj(r.data);
      const status = String(d.status);
      const ref: DomainRef = {
        providerRef: String(d.id),
        name: req.name,
        state: STATE[status] ?? 'unknown',
        expiresAt: str(d.renewal_date) ?? str(d.expiration_date),
        nameservers: req.nameservers ?? [],
        locked: null,
        autoRenew: req.autoRenew,
        privacy: null,
      };
      return {
        status: status === 'ACT' ? 'succeeded' : 'accepted',
        providerRef: ref.providerRef,
        data: ref,
        raw: r.ev,
      };
    });
  }

  async transferIn(
    ctx: AccountContext,
    req: TransferInRequest,
  ): Promise<OperationResult<DomainRef>> {
    return this.safe(ctx, 'transferIn', true, async () => {
      if (!isVaultRef(req.authCodeRef))
        return {
          status: 'failed',
          error: normalizedError(
            'validation',
            'auth_code_ref',
            'authCodeRef must be a vault:// reference',
          ),
          raw: this.evidence('transferIn', 'invalid ref'),
        };
      const prior = await this.findByToken(ctx, req.idempotencyToken, { name: req.name });
      if (prior.status === 'succeeded' && prior.data)
        return {
          status: 'accepted',
          providerRef: prior.data.providerRef,
          data: prior.data,
          raw: this.evidence('transferIn', 'already submitted under this reference'),
        };
      if (prior.status !== 'succeeded')
        return { status: 'uncertain', error: prior.error, raw: prior.raw };
      const code = (await this.o.vault.resolve(req.authCodeRef)).fields.authCode;
      if (!code)
        return {
          status: 'failed',
          error: normalizedError(
            'validation',
            'auth_code_missing',
            'the vault entry holds no authCode',
          ),
          raw: this.evidence('transferIn', 'missing'),
        };
      const h = await this.handles(ctx, req.contacts);
      if (!h.ok) return this.result('transferIn', h);
      const r = await this.call(
        ctx,
        'POST',
        '/domains/transfer',
        {
          domain: splitName(req.name),
          auth_code: code,
          owner_handle: h.h.registrant,
          admin_handle: h.h.admin,
          tech_handle: h.h.tech,
          billing_handle: h.h.billing,
          ...(req.nameservers?.length
            ? { name_servers: req.nameservers.map((n) => ({ name: n })) }
            : { ns_group: 'dns-openprovider' }),
          autorenew: 'default',
          period: 1,
          is_private_whois_enabled: req.privacy,
          comments: commentFor(req.idempotencyToken),
        },
        { mutating: true, op: 'transferIn' },
      );
      if (!r.ok) return this.result('transferIn', r);
      const d = obj(r.data);
      const ref: DomainRef = {
        providerRef: String(d.id),
        name: req.name,
        state: d.status === 'ACT' ? 'active' : 'transferring',
        expiresAt: str(d.renewal_date) ?? str(d.expiration_date),
        nameservers: [],
        locked: null,
        autoRenew: null,
        privacy: null,
      };
      return {
        status: d.status === 'ACT' ? 'succeeded' : 'accepted',
        providerRef: ref.providerRef,
        data: ref,
        raw: r.ev,
      };
    });
  }

  async renew(ctx: AccountContext, req: RenewRequest): Promise<OperationResult<DomainRef>> {
    return this.safe(ctx, 'renew', true, async () => {
      // double-renew guard (docs §3.6: no idempotency key): if the expiry already moved past the one the order was placed against, it is done
      const cur = await this.inspect(ctx, req.name);
      if (cur.status !== 'succeeded')
        return { status: 'uncertain', error: cur.error, raw: cur.raw };
      if (!cur.data)
        return {
          status: 'failed',
          error: normalizedError(
            'not_found',
            'not_found',
            'the domain does not exist at the registrar',
          ),
          raw: cur.raw,
        };
      if (
        req.currentExpiresAt &&
        cur.data.expiresAt &&
        Date.parse(cur.data.expiresAt) > Date.parse(req.currentExpiresAt)
      )
        return {
          status: 'succeeded',
          providerRef: cur.data.providerRef,
          data: cur.data,
          raw: this.evidence('renew', 'already renewed: expiry moved past the order baseline'),
        };
      const r = await this.call(
        ctx,
        'POST',
        `/domains/${encodeURIComponent(req.providerRef)}/renew`,
        { domain: splitName(req.name), id: Number(req.providerRef), period: req.years },
        { mutating: true, op: 'renew' },
      );
      if (!r.ok) return this.result('renew', r);
      const after = await this.inspect(ctx, req.name);
      return {
        status: 'succeeded',
        providerRef: req.providerRef,
        data: after.data ?? cur.data,
        raw: r.ev,
      };
    });
  }

  // ---- modify -----------------------------------------------------------------------------------------------------------------
  private async modify(
    ctx: AccountContext,
    name: string,
    op: string,
    patch: Obj,
  ): Promise<OperationResult<DomainRef>> {
    return this.safe(ctx, op, true, async () => {
      const cur = await this.inspect(ctx, name);
      if (cur.status !== 'succeeded' || !cur.data)
        return {
          status: cur.status === 'succeeded' ? 'failed' : 'failed',
          error:
            cur.error ??
            normalizedError('not_found', 'not_found', 'the domain does not exist at the registrar'),
          raw: cur.raw,
        };
      const r = await this.call(
        ctx,
        'PUT',
        `/domains/${encodeURIComponent(cur.data.providerRef)}`,
        { id: Number(cur.data.providerRef), domain: splitName(name), ...patch },
        { mutating: true, op },
      );
      if (!r.ok) return this.result(op, r);
      const after = await this.inspect(ctx, name);
      return {
        status: 'succeeded',
        providerRef: cur.data.providerRef,
        data: after.data ?? cur.data,
        raw: r.ev,
      };
    });
  }
  setNameservers(ctx: AccountContext, name: string, nameservers: string[]) {
    return this.modify(ctx, name, 'setNameservers', {
      name_servers: nameservers.map((n, i) => ({ name: n, seq_nr: i + 1 })),
    });
  }
  setLock(ctx: AccountContext, name: string, locked: boolean) {
    return this.modify(ctx, name, 'setLock', { is_locked: locked });
  }
  setAutoRenew(ctx: AccountContext, name: string, autoRenew: boolean) {
    return this.modify(ctx, name, 'setAutoRenew', { autorenew: autoRenew ? 'on' : 'off' });
  }
  async setContacts(
    ctx: AccountContext,
    name: string,
    contacts: ContactSet,
  ): Promise<OperationResult<DomainRef>> {
    const h = await this.safe(ctx, 'setContacts', true, async () => {
      const x = await this.handles(ctx, contacts);
      return x.ok
        ? {
            status: 'succeeded' as const,
            data: x.h,
            raw: this.evidence('setContacts', 'handles created'),
          }
        : this.result<Record<string, string>>('setContacts', x);
    });
    if (h.status !== 'succeeded') return { status: h.status, error: h.error, raw: h.raw };
    return this.modify(ctx, name, 'setContacts', {
      owner_handle: h.data!.registrant,
      admin_handle: h.data!.admin,
      tech_handle: h.data!.tech,
      billing_handle: h.data!.billing,
    });
  }
  async authCode(
    ctx: AccountContext,
    name: string,
    store: AuthCodeStore,
  ): Promise<OperationResult<{ authCodeRef: string }>> {
    return this.safe(ctx, 'authCode', false, async () => {
      const cur = await this.inspect(ctx, name);
      if (cur.status !== 'succeeded' || !cur.data)
        return {
          status: 'failed',
          error:
            cur.error ??
            normalizedError('not_found', 'not_found', 'the domain does not exist at the registrar'),
          raw: cur.raw,
        };
      const r = await this.call(
        ctx,
        'GET',
        `/domains/${encodeURIComponent(cur.data.providerRef)}/authcode?auth_code_type=external`,
        undefined,
        { mutating: false, op: 'authCode' },
      );
      if (!r.ok) return this.result('authCode', r);
      const code = str(obj(r.data).auth_code);
      if (!code)
        return {
          status: 'failed',
          error: normalizedError(
            'unsupported',
            'no_auth_code',
            'the registrar did not return an auth code for this domain',
          ),
          raw: r.ev,
        };
      const ref = await store.put(code, `authcode-${name}`);
      return { status: 'succeeded', data: { authCodeRef: ref }, raw: r.ev };
    });
  }

  // ---- billing / webhooks ---------------------------------------------------------------------------------------------------------
  async fetchBilling(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]> {
    const r = await this.call(
      ctx,
      'GET',
      `/transactions?start_creation_date=${encodeURIComponent(period.from)}&end_creation_date=${encodeURIComponent(period.to)}&limit=500`,
      undefined,
      { mutating: false, op: 'billing' },
    );
    if (!r.ok) return [];
    const out: ProviderCostRecord[] = [];
    for (const t of arr(obj(r.data).results)) {
      const total = obj(obj(t.total).reseller);
      const currency = String(total.currency ?? '');
      const m = /^[A-Z]{3}$/.test(currency) ? toMinorUnits(total.price, currency) : null;
      if (m === null) continue; // never guess an amount or a currency
      const created = str(t.creation_date) ?? period.from;
      out.push({
        providerRef: t.reference_id === undefined ? null : String(t.reference_id),
        periodStart: created,
        periodEnd: created,
        amountMinor: m,
        currency,
        description: `${String(t.action ?? 'transaction')} ${String(t.subject ?? '')}`.trim(),
      });
    }
    return out;
  }

  /** Signature: HMAC-SHA256 over `<t>.<raw body>`; header `X-Webhook-Signature: t=<unix>,v1=<hex>` (docs §3.12; the exact header serialization is NOT DOCUMENTED: assumption). */
  parseWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    opts: { secret: string; now: Date; toleranceMs: number },
  ): VerifiedEvent {
    const h = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]),
    );
    const sig = h['x-webhook-signature'];
    if (!sig) throw new WebhookRejectedError('bad_signature', 'signature header missing');
    const parts = Object.fromEntries(
      sig.split(',').map((p) => p.trim().split('=') as [string, string]),
    );
    const t = Number(parts.t);
    const v1 = parts.v1 ?? '';
    if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/.test(v1))
      throw new WebhookRejectedError('bad_signature', 'signature header malformed');
    const expected = createHmac('sha256', opts.secret).update(`${parts.t}.${rawBody}`).digest();
    const given = Buffer.from(v1, 'hex');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      throw new WebhookRejectedError('bad_signature', 'signature does not match');
    if (Math.abs(opts.now.getTime() - t * 1000) > opts.toleranceMs)
      throw new WebhookRejectedError('replay', 'delivery is outside the replay window');
    let j: Obj;
    try {
      j = JSON.parse(rawBody) as Obj;
    } catch {
      throw new WebhookRejectedError('malformed', 'body is not JSON');
    }
    const id = str(j.id);
    const type = str(j.eventType);
    if (!id || !type) throw new WebhookRejectedError('malformed', 'id and eventType are required');
    const data = obj(j.data);
    const lc = type.toLowerCase();
    const kind: VerifiedEventKind =
      /regist|created/.test(lc) &&
      /complet|created|success/.test(
        lc +
          String(data.status ?? '')
            .toLowerCase()
            .replace('act', 'success'),
      ) &&
      !/fail|pending/.test(lc)
        ? 'domain.registered'
        : /renew/.test(lc) && !/fail/.test(lc)
          ? 'domain.renewed'
          : /transfer/.test(lc) && /complet/.test(lc) && /incoming|in/.test(lc)
            ? 'domain.transfer_completed'
            : /transfer/.test(lc) && /fail|cancel/.test(lc)
              ? 'domain.transfer_failed'
              : /delete/.test(lc) && /complet/.test(lc)
                ? 'domain.deleted'
                : 'unknown';
    return {
      eventId: id,
      kind,
      rawType: type,
      occurredAt: new Date((Number(j.timeStamp) || t) * 1000).toISOString(),
      domainName: str(data.domain),
      providerRef: data.domainId === undefined ? null : String(data.domainId),
    };
  }
}

class LoginError extends Error {
  constructor(readonly error: NormalizedError) {
    super(error.message);
  }
}

/** DNS through `/dns/zones` (docs §3.10). Non-atomic: every change is its own PUT with a single modifier (the only documented usage). */
class OpenproviderDns implements DnsCapability {
  readonly atomicChangeSet = false;
  constructor(private readonly a: OpenproviderAdapter) {}

  private rel(zone: string, n: string): string {
    return n === zone ? '@' : n.endsWith(`.${zone}`) ? n.slice(0, -(zone.length + 1)) : n;
  }
  /** wire ⇄ neutral. MX: value=host, prio. SRV value "weight port target"; CAA value `flags tag "value"` (formats NOT VERIFIED: docs do not state them). */
  toWire(r: DnsRecordData): Obj {
    const v = r.value as Obj | string;
    const base = { name: r.name === '@' ? '' : r.name, type: r.type, ttl: r.ttl };
    if (r.type === 'MX') return { ...base, value: (v as Obj).host, prio: (v as Obj).priority };
    if (r.type === 'SRV')
      return {
        ...base,
        value: `${(v as Obj).weight} ${(v as Obj).port} ${(v as Obj).target}`,
        prio: (v as Obj).priority,
      };
    if (r.type === 'CAA')
      return { ...base, value: `${(v as Obj).flags} ${(v as Obj).tag} "${(v as Obj).value}"` };
    return { ...base, value: v };
  }
  fromWire(zone: string, w: Obj): DnsRecordData | null {
    const type = String(w.type).toUpperCase() as DnsRecordData['type'];
    if (!['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'].includes(type)) return null;
    const name = this.rel(zone, String(w.name ?? '')) || '@';
    const value = String(w.value ?? '');
    let v: unknown = value;
    if (type === 'MX') v = { priority: Number(w.prio ?? 0), host: value };
    else if (type === 'SRV') {
      const m = /^(\d+) (\d+) (\S+)$/.exec(value);
      if (!m) return null;
      v = { priority: Number(w.prio ?? 0), weight: Number(m[1]), port: Number(m[2]), target: m[3] };
    } else if (type === 'CAA') {
      const m = /^(\d+) (\w+) "(.*)"$/.exec(value);
      if (!m) return null;
      v = { flags: Number(m[1]), tag: m[2], value: m[3] };
    }
    return { name, type, ttl: Number(w.ttl ?? 3600), value: v };
  }
  private same(a: DnsRecordData, b: DnsRecordData) {
    return (
      a.name === b.name && a.type === b.type && JSON.stringify(a.value) === JSON.stringify(b.value)
    );
  }

  async createZone(ctx: AccountContext, zone: string): Promise<OperationResult<DnsZoneState>> {
    return this.a.safe(ctx, 'dns.createZone', true, async () => {
      const exists = await this.listZone(ctx, zone);
      if (exists.status === 'succeeded') return exists;
      const r = await this.a.call(
        ctx,
        'POST',
        '/dns/zones',
        { domain: splitName(zone), type: 'master', records: [] },
        { mutating: true, op: 'dns.createZone' },
      );
      if (!r.ok) return { status: r.status, error: r.error, raw: r.ev };
      return this.listZone(ctx, zone);
    });
  }
  async listZone(ctx: AccountContext, zone: string): Promise<OperationResult<DnsZoneState>> {
    return this.a.safe(ctx, 'dns.listZone', false, async () => {
      const r = await this.a.call(
        ctx,
        'GET',
        `/dns/zones/${encodeURIComponent(zone)}?with_records=true`,
        undefined,
        { mutating: false, op: 'dns.listZone' },
      );
      if (!r.ok) return { status: 'failed', error: r.error, raw: r.ev };
      const z = obj(r.data);
      const records = arr(z.records)
        .map((w) => this.fromWire(zone, w))
        .filter((x): x is DnsRecordData => x !== null);
      return {
        status: 'succeeded',
        providerRef: String(z.id ?? zone),
        data: { zone, providerZoneRef: String(z.id ?? zone), records, observedAt: this.a.now() },
        raw: r.ev,
      };
    });
  }
  async applyChangeSet(ctx: AccountContext, zone: string, changes: DnsChange[]) {
    return this.a.safe<DnsChangeSetOutcome>(ctx, 'dns.apply', true, async () => {
      const results: DnsChangeResult[] = [];
      const before = await this.listZone(ctx, zone);
      if (before.status !== 'succeeded')
        return {
          status: 'failed' as const,
          error: before.error,
          raw: before.raw,
          data: {
            outcome: 'rejected' as const,
            results: changes.map((_, index) => ({ index, status: 'skipped' as const })),
          },
        };
      let stop = false;
      let uncertain = false;
      for (let index = 0; index < changes.length; index++) {
        if (stop) {
          results.push({ index, status: 'skipped' });
          continue;
        }
        const ch = changes[index]!;
        const modifier =
          ch.op === 'create'
            ? { add: [this.toWire(ch.record)] }
            : ch.op === 'delete'
              ? {
                  remove: before
                    .data!.records.filter(
                      (x) => x.name === ch.match.name && x.type === ch.match.type,
                    )
                    .map((x) => this.toWire(x)),
                }
              : {
                  update: before
                    .data!.records.filter(
                      (x) => x.name === ch.match.name && x.type === ch.match.type,
                    )
                    .map((x) => ({
                      original_record: this.toWire(x),
                      record: this.toWire(ch.record),
                    })),
                };
        const r = await this.a.call(
          ctx,
          'PUT',
          `/dns/zones/${encodeURIComponent(zone)}`,
          {
            name: zone,
            domain: splitName(zone),
            type: 'master',
            is_spamexperts_enabled: false,
            records: modifier,
          },
          { mutating: true, op: 'dns.apply' },
        );
        if (r.ok) results.push({ index, status: 'applied' });
        else {
          results.push({ index, status: 'failed', error: r.error.message });
          if (r.status === 'uncertain') uncertain = true;
          stop = true;
        }
      }
      const applied = results.filter((x) => x.status === 'applied').length;
      const outcome =
        applied === changes.length
          ? ('applied' as const)
          : applied === 0
            ? ('rejected' as const)
            : ('partial' as const);
      const first = results.find((x) => x.status === 'failed');
      void first;
      return {
        status:
          outcome === 'applied'
            ? ('succeeded' as const)
            : uncertain
              ? ('uncertain' as const)
              : ('failed' as const),
        data: { outcome, results },
        ...(outcome === 'applied'
          ? {}
          : {
              error: normalizedError(
                uncertain ? 'provider_outage' : 'validation',
                uncertain ? 'timeout' : 'change_failed',
                'the change-set was not fully applied',
                uncertain,
              ),
            }),
        raw: this.a.evidence('dns.apply', `${applied}/${changes.length} applied`),
      };
    });
  }
}
