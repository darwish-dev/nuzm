import {
  AdapterTimeoutError,
  CONTRACT_VERSION,
  Redactor,
  completeCapabilities,
  isVaultRef,
  normalizedError,
  toMinorUnits,
  type AccountContext,
  type AvailabilityResult,
  type CapabilityState,
  type ContactPayload,
  type ContactSet,
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
} from '@nuzm/registrar-contracts';

/**
 * ResellerClub (LogicBoxes HTTP API) RegistrarAdapter. Built ONLY from docs/adapters/resellerclub.md (the vendor site returned 403, so the same KB was read through a
 * white-label host; retrieval date 2026-11-18). NOT VERIFIED against any account (HG-07-01). Documented limitations are honoured, not papered over:
 *  - no client token / idempotency key: the registration is found by DOMAIN NAME under our customer id (domain names are unique), so `findByToken` is a name lookup;
 *  - no webhooks (polling only), no atomic or confirmed-complete DNS API (DNS unsupported here), no standalone auto-renew toggle, no documented auth-code retrieval,
 *    contact modification is deprecated (create-new-and-attach, whose call was not read) ⇒ setContacts/setAutoRenew/authCode are unsupported.
 */
export const RESELLERCLUB_PRODUCTION_URL = 'https://httpapi.com';
export const RESELLERCLUB_TEST_URL = 'https://test.httpapi.com';
export const RESELLERCLUB_DOMAINCHECK_URL = 'https://domaincheck.httpapi.com';
export const RESELLERCLUB_HOSTS = [
  'httpapi.com',
  'test.httpapi.com',
  'domaincheck.httpapi.com',
] as const;

export interface ResellerClubOptions {
  baseUrl: string;
  domainCheckUrl: string;
  http: HttpClient;
  vault: VaultClient;
  evidenceKind: EvidenceKind;
  /** The cost-price API does not state a currency (docs §3.1 / gap 13): it is configured per account. */
  currency: string;
  /** `ns` is required by register; used when the order carries no nameservers. */
  defaultNameservers: string[];
  now?: () => Date;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null;
const bool = (v: unknown): boolean | null =>
  v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;

/** TLD → product key (docs §3.1: "dot"+tld with documented exceptions). The full table is on a page we cannot reproduce: unknown TLDs simply get no price. */
const PRODUCT_KEY: Record<string, string> = {
  com: 'domcno',
  org: 'domorg',
  biz: 'dombiz',
  info: 'dominfo',
  us: 'domus',
};
export const productKey = (tld: string): string =>
  PRODUCT_KEY[tld] ?? `dot${tld.replace(/\./g, '')}`;

const SYMBOL: Record<string, string> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
  SAR: 'SAR',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
};

/** The vendor documents NO error codes: classification is by message text and is itself an assumption (docs §4 / gap 12). */
export function classifyMessage(msg: string): { category: ErrorCategory; retryable: boolean } {
  const m = msg.toLowerCase();
  if (
    /access denied|invalid (credentials|api|auth)|authentication|not authori[sz]ed|api key/.test(m)
  )
    return { category: 'auth', retryable: false };
  if (/too many|rate limit|slow down|exceed/.test(m))
    return { category: 'rate_limit', retryable: true };
  if (/unable to connect|try again|temporar|unavailable|timed out|maintenance/.test(m))
    return { category: 'provider_outage', retryable: true };
  if (/insufficient|not enough (funds|balance)/.test(m))
    return { category: 'quota', retryable: false };
  if (
    /already (registered|exists|in use)|not available|is taken|unavailable for registration/.test(m)
  )
    return { category: 'conflict', retryable: false };
  if (/no entity|not found|does not exist|no such|invalid (order|entity)/.test(m))
    return { category: 'not_found', retryable: false };
  if (/locked|not unlocked|transfer.*(not allowed|prohibited)/.test(m))
    return { category: 'validation', retryable: false };
  if (/invalid|please|required|must|not valid|missing/.test(m))
    return { category: 'validation', retryable: false };
  return { category: 'unknown', retryable: false };
}

const STATE: Record<string, ProviderDomainState> = {
  active: 'active',
  inactive: 'pending',
  'pending verification': 'pending',
  suspended: 'unknown',
  'pending delete restorable': 'redemption',
  deleted: 'expired',
  archived: 'expired',
  'failed verification': 'failed',
};

type Failure = {
  ok: false;
  status: 'failed' | 'uncertain';
  error: NormalizedError;
  ev: RawEvidence;
};
type Success = { ok: true; data: unknown; ev: RawEvidence };

export class ResellerClubAdapter implements RegistrarAdapter {
  readonly id = 'resellerclub';
  readonly providerCode = 'resellerclub';
  readonly kind = 'registrar' as const;
  readonly contractVersion = CONTRACT_VERSION;
  private costCache: { at: number; data: Obj } | null = null;

  constructor(private readonly o: ResellerClubOptions) {}

  now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private ev(
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
    return {
      m,
      userId: m.fields.authUserId ?? '',
      apiKey: m.fields.apiKey ?? '',
      customerId: m.fields.customerId ?? '',
    };
  }

  /** Builds the query string the way the docs describe: arrays repeat the parameter, maps use numbered suffixes (callers pass them already expanded). */
  private qs(params: Record<string, string | number | boolean | string[] | undefined>): string {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const x of v) p.append(k, x);
      else p.append(k, String(v));
    }
    return p.toString();
  }

  private async call(
    ctx: AccountContext,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, string | number | boolean | string[] | undefined>,
    opts: { mutating: boolean; op: string; host?: 'main' | 'check' },
  ): Promise<Success | Failure> {
    const c = await this.creds(ctx);
    const red = new Redactor().register(Object.values(c.m.fields));
    const fail = (status: 'failed' | 'uncertain', error: NormalizedError): Failure => ({
      ok: false,
      status,
      error,
      ev: this.ev(opts.op, red.string(error.message), undefined, {
        providerCode: error.providerCode,
      }),
    });
    const base = opts.host === 'check' ? this.o.domainCheckUrl : this.o.baseUrl;
    const url = `${base}${path}?${this.qs({ 'auth-userid': c.userId, 'api-key': c.apiKey, ...params })}`;
    try {
      const res = await this.o.http.request({ method, url, deadlineMs: ctx.deadlineMs });
      let json: unknown;
      try {
        json = JSON.parse(res.text);
      } catch {
        return fail(
          opts.mutating ? 'uncertain' : 'failed',
          normalizedError(
            'provider_outage',
            `http_${res.status}`,
            'the registrar returned an unreadable answer',
            true,
          ),
        );
      }
      const o = obj(json);
      const status = typeof o.status === 'string' ? o.status.toLowerCase() : '';
      const message = str(o.message) ?? str(o.error);
      if (status === 'error' || (message && o.error !== undefined && status !== 'success')) {
        const k = classifyMessage(message ?? '');
        return fail(
          'failed',
          normalizedError(
            k.category,
            k.category,
            red.string(message ?? 'registrar error'),
            k.retryable,
          ),
        );
      }
      return {
        ok: true,
        data: json,
        ev: this.ev(opts.op, `${method} ${path} ok`, { method, path }, { ok: true }),
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
  private res<T>(f: Failure): OperationResult<T> {
    return { status: f.status, error: f.error, raw: f.ev };
  }
  private unsupported<T>(op: string, what: string): OperationResult<T> {
    return {
      status: 'failed',
      error: normalizedError(
        'unsupported',
        'unsupported',
        `${what} is not supported by this registrar adapter`,
      ),
      raw: this.ev(op, `unsupported: ${what}`),
    };
  }

  // ---- probe / catalogue ------------------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext): Promise<RegistrarCapabilityReport> {
    const caps: Partial<Record<RegistrarCapabilityId, CapabilityState>> = {};
    const ev: RawEvidence[] = [];
    const info = await this.call(
      ctx,
      'POST',
      '/api/domains/tld-info.json',
      {},
      { mutating: false, op: 'probe.tld-info' },
    );
    ev.push(info.ev);
    if (!info.ok)
      return { capabilities: completeCapabilities({}), evidence: ev, probedAt: this.now() };
    const avail = await this.call(
      ctx,
      'GET',
      '/api/domains/available.json',
      { 'domain-name': ['nuzm-probe'], tlds: ['com'] },
      { mutating: false, op: 'probe.available', host: 'check' },
    );
    ev.push(avail.ok ? avail.ev : avail.ev);
    const tlds = Object.values(obj(info.data));
    const any = tlds.length > 0;
    caps['registrar.search'] = avail.ok ? 'supported' : 'unsupported';
    // register/renew/transfer cannot be proven without a side effect: derived from the signed-up TLD list (docs §3.2)
    caps['registrar.register'] = any && avail.ok ? 'supported' : 'unknown';
    caps['registrar.renew'] = caps['registrar.register'];
    caps['registrar.transfer-in'] = caps['registrar.register'];
    caps['registrar.nameservers'] = caps['registrar.register'];
    caps['registrar.lock'] = tlds.some((t) => bool(obj(t).locking_available) === true)
      ? 'supported'
      : 'unknown';
    caps['registrar.privacy'] = tlds.some((t) => bool(obj(t).privacy_available) === true)
      ? 'supported'
      : 'unknown';
    caps['registrar.find-by-token'] = caps['registrar.register']; // by DOMAIN NAME under our customer id: documented lookup, no client token exists
    caps['registrar.contacts'] = 'unsupported'; // modify deprecated; attach-new-contact call not read (docs §3.3)
    caps['registrar.auth-code'] = 'unsupported'; // no documented retrieval call (docs §3.8)
    caps['registrar.dns'] = 'unsupported'; // only A/TXT pages read, per-record and non-atomic (docs §3.9)
    caps['registrar.dnssec'] = 'unknown';
    caps['registrar.eligibility'] = 'unsupported';
    caps['registrar.webhooks'] = 'unsupported'; // polling only (docs §3.10)
    const tx = await this.call(
      ctx,
      'GET',
      '/api/billing/my-transactions/search.json',
      { 'no-of-records': 10, 'page-no': 1 },
      { mutating: false, op: 'probe.billing' },
    );
    ev.push(tx.ev);
    caps['registrar.billing-export'] = tx.ok ? 'supported' : 'unsupported';
    return { capabilities: completeCapabilities(caps), evidence: ev, probedAt: this.now() };
  }

  async health(ctx: AccountContext): Promise<HealthReport> {
    const t0 = Date.now();
    const r = await this.call(
      ctx,
      'POST',
      '/api/domains/tld-info.json',
      {},
      { mutating: false, op: 'health' },
    );
    const state = r.ok
      ? 'healthy'
      : r.error.category === 'provider_outage'
        ? 'unhealthy'
        : r.error.category === 'auth'
          ? 'degraded'
          : 'unknown';
    return {
      state,
      checkedAt: this.now(),
      latencyMs: Date.now() - t0,
      detail: r.ok ? undefined : r.error.providerCode,
      evidence: [r.ev],
    };
  }

  async catalog(ctx: AccountContext): Promise<TldCatalogSnapshot> {
    const tlds = await this.supportedTlds(ctx);
    return { takenAt: this.now(), tlds, evidence: [this.ev('catalog', `${tlds.length} TLDs`)] };
  }

  private async costs(ctx: AccountContext): Promise<Obj> {
    if (this.costCache && Date.now() - this.costCache.at < 15 * 60_000) return this.costCache.data;
    const r = await this.call(
      ctx,
      'GET',
      '/api/products/reseller-cost-price.json',
      {},
      { mutating: false, op: 'cost-price' },
    );
    const data = r.ok ? obj(r.data) : {};
    if (r.ok) this.costCache = { at: Date.now(), data };
    return data;
  }
  private price(
    costs: Obj,
    tld: string,
    action: string,
    years = 1,
  ): { amountMinor: string; currency: string } | null {
    const v = obj(obj(costs[productKey(tld)])[action])[String(years)];
    const m = toMinorUnits(
      typeof v === 'string' || typeof v === 'number' ? v : null,
      this.o.currency,
    );
    return m === null ? null : { amountMinor: m, currency: this.o.currency };
  }

  async supportedTlds(ctx: AccountContext): Promise<TldSupport[]> {
    const info = await this.call(
      ctx,
      'POST',
      '/api/domains/tld-info.json',
      {},
      { mutating: false, op: 'tld-info' },
    );
    if (!info.ok) return [];
    const costs = await this.costs(ctx);
    return Object.entries(obj(info.data)).map(([tld, v]) => {
      const t = obj(v);
      const tenures = Object.keys(obj(obj(costs[productKey(tld)]).addnewdomain))
        .map(Number)
        .filter(Number.isFinite);
      const priv = bool(t.privacy_available);
      const transferPrice = this.price(costs, tld, 'addtransferdomain');
      return {
        tld,
        register: 'supported',
        transfer: transferPrice ? 'supported' : 'unknown',
        renew: 'supported',
        dns: 'unsupported',
        privacy: priv === null ? 'unknown' : priv ? 'supported' : 'unsupported',
        dnssec: 'unknown',
        eligibilityRules: 'unknown',
        restricted: str(t.type)?.toLowerCase() === 'cctld', // conservative: ccTLDs frequently carry local-presence rules (not stated by the vendor)
        minYears: tenures.length ? Math.min(...tenures) : 1,
        maxYears: tenures.length ? Math.max(...tenures) : 10,
        requiredContactFields: [],
        prices: {
          register: this.price(costs, tld, 'addnewdomain'),
          renew: this.price(costs, tld, 'renewdomain'),
          transfer: transferPrice,
        },
      } satisfies TldSupport;
    });
  }

  async search(
    ctx: AccountContext,
    names: string[],
    tlds: string[],
  ): Promise<AvailabilityResult[]> {
    const r = await this.call(
      ctx,
      'GET',
      '/api/domains/available.json',
      { 'domain-name': names, tlds },
      { mutating: false, op: 'search', host: 'check' },
    );
    const costs = r.ok ? await this.costs(ctx) : {};
    const out: AvailabilityResult[] = [];
    for (const n of names)
      for (const t of tlds) {
        const full = `${n}.${t}`;
        const x = r.ok ? obj(obj(r.data)[full]) : {};
        const s = str(x.status);
        out.push({
          name: full,
          tld: t,
          available:
            s === 'available'
              ? true
              : s === 'regthroughus' || s === 'regthroughothers'
                ? false
                : 'unknown',
          premium: x.costHash !== undefined && obj(x.costHash).create !== undefined, // premium names are not sold in this milestone (policy)
          registerPrice: this.price(costs, t, 'addnewdomain'),
          renewPrice: this.price(costs, t, 'renewdomain'),
          transferPrice: this.price(costs, t, 'addtransferdomain'),
          cacheTtlSeconds: s === undefined || s === 'unknown' ? 0 : 60,
          observedAt: this.now(),
        });
      }
    return out;
  }

  // ---- lookups -----------------------------------------------------------------------------------------------------------------
  private toRef(name: string, d: Obj): DomainRef {
    const end = Number(d.endtime);
    const ns = ['ns1', 'ns2', 'ns3', 'ns4'].map((k) => str(d[k])).filter((x): x is string => !!x);
    const status = str(d.currentstatus)?.toLowerCase() ?? '';
    const locks = Array.isArray(d.orderstatus)
      ? (d.orderstatus as unknown[]).map((x) => String(x).toLowerCase())
      : [];
    return {
      providerRef: String(d.orderid ?? d.entityid ?? ''),
      name,
      state: STATE[status] ?? 'unknown',
      expiresAt: Number.isFinite(end) && end > 0 ? new Date(end * 1000).toISOString() : null,
      nameservers: ns,
      locked:
        locks.length === 0 && d.orderstatus === undefined ? null : locks.includes('transferlock'),
      autoRenew: bool(d.recurring),
      privacy:
        bool(d.privacyprotectedallowed) === false
          ? 'unsupported'
          : bool(d.isprivacyprotected) === true
            ? 'on'
            : bool(d.isprivacyprotected) === false
              ? 'off'
              : null,
    };
  }

  /** Existence under OUR customer id, by the documented search call (a count, so absence is provable). */
  private async exists(
    ctx: AccountContext,
    name: string,
  ): Promise<{ ok: true; row: Obj | null } | Failure> {
    const c = await this.creds(ctx);
    const r = await this.call(
      ctx,
      'GET',
      '/api/domains/search.json',
      { 'domain-name': name, 'customer-id': c.customerId, 'no-of-records': 10, 'page-no': 1 },
      { mutating: false, op: 'findByToken' },
    );
    if (!r.ok) return r;
    const o = obj(r.data);
    const n = Number(o.recsindb);
    if (!Number.isFinite(n))
      return {
        ok: false,
        status: 'failed',
        error: normalizedError(
          'unknown',
          'unreadable',
          'the registrar search answer was not understood',
        ),
        ev: r.ev,
      };
    if (n === 0) return { ok: true, row: null };
    const row = Object.entries(o).find(
      ([k, v]) => /^\d+$/.test(k) && str(obj(v).domainname)?.toLowerCase() === name,
    )?.[1];
    return { ok: true, row: row ? obj(row) : null };
  }

  async findByToken(
    ctx: AccountContext,
    token: string,
    hint: { name: string },
  ): Promise<OperationResult<DomainRef | null>> {
    void token; // the vendor has no client token (docs §3.4): the name under our customer id is the key
    const e = await this.exists(ctx, hint.name);
    if (!e.ok) return { status: 'uncertain', error: e.error, raw: e.ev };
    if (!e.row)
      return {
        status: 'succeeded',
        data: null,
        raw: this.ev('findByToken', 'absent: no order for this name under our customer'),
      };
    const d = await this.inspect(ctx, hint.name);
    return d.status === 'succeeded' && d.data
      ? { status: 'succeeded', data: d.data, providerRef: d.data.providerRef, raw: d.raw }
      : { status: 'uncertain', error: d.error, raw: d.raw };
  }

  async inspect(ctx: AccountContext, name: string): Promise<OperationResult<DomainRef | null>> {
    const r = await this.call(
      ctx,
      'GET',
      '/api/domains/details-by-name.json',
      { 'domain-name': name, options: ['All'] },
      { mutating: false, op: 'inspect' },
    );
    if (!r.ok) {
      // absence has no documented message: only a not_found-looking message is read as absent, anything else stays a failure (never "absent" by guess)
      return r.error.category === 'not_found'
        ? { status: 'succeeded', data: null, raw: r.ev }
        : { status: 'failed', error: r.error, raw: r.ev };
    }
    const ref = this.toRef(name, obj(r.data));
    return { status: 'succeeded', providerRef: ref.providerRef, data: ref, raw: r.ev };
  }

  // ---- contacts / register ------------------------------------------------------------------------------------------------------
  private async contactIds(
    ctx: AccountContext,
    contacts: ContactSet,
  ): Promise<{ ok: true; ids: Record<string, string> } | Failure> {
    const c = await this.creds(ctx);
    const byKey = new Map<string, string>();
    const ids: Record<string, string> = {};
    for (const role of ['registrant', 'admin', 'tech', 'billing'] as const) {
      const p: ContactPayload = contacts[role];
      const key = JSON.stringify(p);
      let id = byKey.get(key);
      if (!id) {
        const m = /^\+(\d{1,3})(\d{4,12})$/.exec(p.phone);
        const r = await this.call(
          ctx,
          'POST',
          '/api/contacts/add.json',
          {
            name: `${p.firstName} ${p.lastName}`,
            company: p.organization ?? 'N/A',
            email: p.email,
            'address-line-1': p.address.street,
            city: p.address.city,
            state: p.address.state ?? 'Not Applicable',
            country: p.address.country,
            zipcode: p.address.postalCode,
            'phone-cc': m?.[1] ?? '0',
            phone: m?.[2] ?? p.phone,
            'customer-id': c.customerId,
            type: 'Contact',
          },
          { mutating: true, op: 'contacts.add' },
        );
        if (!r.ok) return r;
        id = String(r.data);
        byKey.set(key, id);
      }
      ids[role] = id;
    }
    return { ok: true, ids };
  }

  private async afterAction(
    ctx: AccountContext,
    name: string,
    ev: RawEvidence,
    pendingState: 'pending' | 'transferring',
  ): Promise<OperationResult<DomainRef>> {
    const d = await this.inspect(ctx, name);
    if (d.status === 'succeeded' && d.data) {
      const done = d.data.state === 'active';
      return {
        status: done ? 'succeeded' : 'accepted',
        providerRef: d.data.providerRef,
        data: done ? d.data : { ...d.data, state: pendingState },
        raw: ev,
      };
    }
    // the action was accepted but the read-back failed: the order exists, its state is simply not known yet
    return {
      status: 'accepted',
      raw: ev,
      data: {
        providerRef: '',
        name,
        state: pendingState,
        expiresAt: null,
        nameservers: [],
        locked: null,
        autoRenew: null,
        privacy: null,
      },
    };
  }

  async register(ctx: AccountContext, req: RegisterRequest): Promise<OperationResult<DomainRef>> {
    const prior = await this.findByToken(ctx, req.idempotencyToken, { name: req.name });
    if (prior.status === 'succeeded' && prior.data)
      return {
        status: prior.data.state === 'active' ? 'succeeded' : 'accepted',
        providerRef: prior.data.providerRef,
        data: prior.data,
        raw: this.ev('register', 'already registered under our customer'),
      };
    if (prior.status !== 'succeeded')
      return { status: 'uncertain', error: prior.error, raw: prior.raw };
    const ids = await this.contactIds(ctx, req.contacts);
    if (!ids.ok) return this.res(ids);
    const c = await this.creds(ctx);
    const r = await this.call(
      ctx,
      'POST',
      '/api/domains/register.json',
      {
        'domain-name': req.name,
        years: req.years,
        ns: req.nameservers?.length ? req.nameservers : this.o.defaultNameservers,
        'customer-id': c.customerId,
        'reg-contact-id': ids.ids.registrant,
        'admin-contact-id': ids.ids.admin,
        'tech-contact-id': ids.ids.tech,
        'billing-contact-id': ids.ids.billing,
        'invoice-option': 'NoInvoice',
        'auto-renew': req.autoRenew,
        'purchase-privacy': req.privacy,
        'protect-privacy': req.privacy,
      },
      { mutating: true, op: 'register' },
    );
    if (!r.ok) return this.res(r);
    return this.afterAction(ctx, req.name, r.ev, 'pending');
  }

  async transferIn(
    ctx: AccountContext,
    req: TransferInRequest,
  ): Promise<OperationResult<DomainRef>> {
    if (!isVaultRef(req.authCodeRef))
      return {
        status: 'failed',
        error: normalizedError(
          'validation',
          'auth_code_ref',
          'authCodeRef must be a vault:// reference',
        ),
        raw: this.ev('transferIn', 'invalid ref'),
      };
    const prior = await this.findByToken(ctx, req.idempotencyToken, { name: req.name });
    if (prior.status === 'succeeded' && prior.data)
      return {
        status: 'accepted',
        providerRef: prior.data.providerRef,
        data: prior.data,
        raw: this.ev('transferIn', 'already submitted'),
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
        raw: this.ev('transferIn', 'missing'),
      };
    const v = await this.call(
      ctx,
      'GET',
      '/api/domains/validate-transfer.json',
      { 'domain-name': req.name },
      { mutating: false, op: 'transfer.validate' },
    );
    if (!v.ok) return this.res(v);
    if (bool(v.data) === false)
      return {
        status: 'failed',
        error: normalizedError(
          'validation',
          'transfer_not_possible',
          'the registrar says this domain cannot be transferred (locked or not eligible)',
        ),
        raw: v.ev,
      };
    const ids = await this.contactIds(ctx, req.contacts);
    if (!ids.ok) return this.res(ids);
    const c = await this.creds(ctx);
    const r = await this.call(
      ctx,
      'POST',
      '/api/domains/transfer.json',
      {
        'domain-name': req.name,
        'auth-code': code,
        'customer-id': c.customerId,
        'reg-contact-id': ids.ids.registrant,
        'admin-contact-id': ids.ids.admin,
        'tech-contact-id': ids.ids.tech,
        'billing-contact-id': ids.ids.billing,
        'invoice-option': 'NoInvoice',
        'auto-renew': false,
        ns: req.nameservers?.length ? req.nameservers : undefined,
        'purchase-privacy': req.privacy,
      },
      { mutating: true, op: 'transferIn' },
    );
    if (!r.ok) return this.res(r);
    return {
      status: 'accepted',
      providerRef: str(obj(r.data).entityid) ?? undefined,
      data: {
        providerRef: str(obj(r.data).entityid) ?? '',
        name: req.name,
        state: 'transferring',
        expiresAt: null,
        nameservers: [],
        locked: null,
        autoRenew: null,
        privacy: null,
      },
      raw: r.ev,
    };
  }

  async renew(ctx: AccountContext, req: RenewRequest): Promise<OperationResult<DomainRef>> {
    const cur = await this.inspect(ctx, req.name);
    if (cur.status !== 'succeeded') return { status: 'uncertain', error: cur.error, raw: cur.raw };
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
        raw: this.ev('renew', 'already renewed: expiry moved past the order baseline'),
      };
    const r = await this.call(
      ctx,
      'POST',
      '/api/domains/renew.json',
      {
        'order-id': req.providerRef,
        years: req.years,
        'exp-date': Math.floor(Date.parse(cur.data.expiresAt ?? req.currentExpiresAt ?? '') / 1000),
        'auto-renew': false,
        'invoice-option': 'NoInvoice',
      },
      { mutating: true, op: 'renew' },
    );
    if (!r.ok) return this.res(r);
    const after = await this.inspect(ctx, req.name);
    return {
      status: 'succeeded',
      providerRef: req.providerRef,
      data: after.data ?? cur.data,
      raw: r.ev,
    };
  }

  private async byOrder(
    ctx: AccountContext,
    name: string,
  ): Promise<{ ok: true; ref: DomainRef } | { ok: false; res: OperationResult<DomainRef> }> {
    const cur = await this.inspect(ctx, name);
    if (cur.status !== 'succeeded' || !cur.data)
      return {
        ok: false,
        res: {
          status: 'failed',
          error:
            cur.error ??
            normalizedError('not_found', 'not_found', 'the domain does not exist at the registrar'),
          raw: cur.raw,
        },
      };
    return { ok: true, ref: cur.data };
  }
  async setNameservers(
    ctx: AccountContext,
    name: string,
    nameservers: string[],
  ): Promise<OperationResult<DomainRef>> {
    const o = await this.byOrder(ctx, name);
    if (!o.ok) return o.res;
    const r = await this.call(
      ctx,
      'POST',
      '/api/domains/modify-ns.json',
      { 'order-id': o.ref.providerRef, ns: nameservers },
      { mutating: true, op: 'setNameservers' },
    );
    if (!r.ok) return this.res(r);
    const after = await this.inspect(ctx, name);
    return {
      status: 'succeeded',
      providerRef: o.ref.providerRef,
      data: after.data ?? o.ref,
      raw: r.ev,
    };
  }
  async setLock(
    ctx: AccountContext,
    name: string,
    locked: boolean,
  ): Promise<OperationResult<DomainRef>> {
    const o = await this.byOrder(ctx, name);
    if (!o.ok) return o.res;
    const r = await this.call(
      ctx,
      'POST',
      `/api/domains/${locked ? 'enable' : 'disable'}-theft-protection.json`,
      { 'order-id': o.ref.providerRef },
      { mutating: true, op: 'setLock' },
    );
    if (!r.ok) return this.res(r);
    const after = await this.inspect(ctx, name);
    return {
      status: 'succeeded',
      providerRef: o.ref.providerRef,
      data: after.data ?? o.ref,
      raw: r.ev,
    };
  }
  async setAutoRenew(
    _c: AccountContext,
    _n: string,
    _a: boolean,
  ): Promise<OperationResult<DomainRef>> {
    return this.unsupported(
      'setAutoRenew',
      'a standalone auto-renew change (only the auto-renew parameter of register/renew exists)',
    );
  }
  async setContacts(
    _c: AccountContext,
    _n: string,
    _x: ContactSet,
  ): Promise<OperationResult<DomainRef>> {
    return this.unsupported(
      'setContacts',
      'changing contacts of an existing domain (contact modification is deprecated by the vendor)',
    );
  }
  async fetchBilling(
    ctx: AccountContext,
    period: { from: string; to: string },
  ): Promise<ProviderCostRecord[]> {
    const r = await this.call(
      ctx,
      'GET',
      '/api/billing/my-transactions/search.json',
      {
        'no-of-records': 500,
        'page-no': 1,
        'transaction-type': 'debit',
        'transaction-date-start': Math.floor(Date.parse(period.from) / 1000),
        'transaction-date-end': Math.floor(Date.parse(period.to) / 1000),
      },
      { mutating: false, op: 'billing' },
    );
    if (!r.ok) return [];
    const out: ProviderCostRecord[] = [];
    for (const [k, v] of Object.entries(obj(r.data))) {
      if (!/^\d+$/.test(k)) continue;
      const t = obj(v);
      const currency = SYMBOL[str(t.sellingcurrencysymbol) ?? ''];
      const amountMinor = currency ? toMinorUnits(t.sellingamount, currency) : null;
      const at = Number(t.transactiondate);
      if (!currency || amountMinor === null || !Number.isFinite(at)) continue; // never guess a currency or an amount
      const iso = new Date(at * 1000).toISOString();
      out.push({
        providerRef: str(t.transid),
        periodStart: iso,
        periodEnd: iso,
        amountMinor,
        currency,
        description: str(t.description) ?? 'transaction',
      });
    }
    return out;
  }
}
