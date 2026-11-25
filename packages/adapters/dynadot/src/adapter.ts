import {
  AdapterTimeoutError,
  CONTRACT_VERSION,
  Redactor,
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
  type DomainRef,
  type ErrorCategory,
  type EvidenceKind,
  type HealthReport,
  type HttpClient,
  type NormalizedError,
  type OperationResult,
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
 * Dynadot RegistrarAdapter, built ONLY from Dynadot's published API documentation (https://www.dynadot.com/domain/api-commands, read 2026-11-24). NOT VERIFIED
 * against any account (HG-07-01): nothing here has ever called Dynadot.
 *
 * WHICH API: Dynadot has two. The RESTful API (`/restful/v2/…`, Bearer key + HMAC `X-Signature`, "Beta" per its own page) publishes its per-command reference only
 * behind a client-rendered page that carries nothing we could read (two example paths: `domains/{domain_name}/search`, `accounts/info`), so no REST command is
 * invented here. The Legacy API (`api3.json`, command + parameters) is fully documented per command and is what this adapter speaks; Dynadot marks it "scheduled
 * for retirement". The transport is isolated in `call()` so a REST implementation can replace it without touching the contract methods (open item DYN-1).
 *
 * Documented limitations that are honoured, not papered over:
 *  - no client token / idempotency key: a registration is found by DOMAIN NAME under our account (`domain_info`), so `findByToken` is a name lookup;
 *  - `set_ns` needs the name servers to exist in the account first (`add_ns`), which `setNameservers` does;
 *  - `set_dns2` replaces a zone wholesale with a handful of record types ⇒ DNS is `unsupported` (Nuzm operates DNS itself);
 *  - no webhooks in the Legacy API, no documented billing export that we read ⇒ unsupported;
 *  - the key travels as a query parameter over https (the documented transport); evidence stores the command name only, never the URL.
 */
export const DYNADOT_PRODUCTION_URL = 'https://api.dynadot.com';
export const DYNADOT_SANDBOX_URL = 'https://api-sandbox.dynadot.com';
export const DYNADOT_HOSTS = ['api.dynadot.com', 'api-sandbox.dynadot.com'] as const;

export interface DynadotOptions {
  baseUrl: string;
  http: HttpClient;
  vault: VaultClient;
  evidenceKind: EvidenceKind;
  /** Prices and orders are placed in this currency (the `currency` parameter); the account default applies when empty. */
  currency: string;
  /** Domains per `search` call: 1 for a regular account, up to 100 for bulk accounts (docs). */
  searchBatch?: number;
  now?: () => Date;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : null;
const yes = (v: unknown): boolean | null => {
  const s = str(v)?.toLowerCase();
  return s === 'yes' || s === 'true' || s === '1'
    ? true
    : s === 'no' || s === 'false' || s === '0'
      ? false
      : null;
};

/** The vendor documents no error codes: classification is by message text and is itself an assumption (NOT VERIFIED). */
export function classifyMessage(msg: string): { category: ErrorCategory; retryable: boolean } {
  const m = msg.toLowerCase();
  if (
    /(invalid|wrong|missing|unknown|disabled|expired) (api )?key|api (access|key)|not authori[sz]ed|permission|ip (is )?not (allowed|whitelisted)|access denied|authenticat/.test(
      m,
    )
  )
    return { category: 'auth', retryable: false };
  if (/too many|rate limit|slow down|exceed|thread/.test(m))
    return { category: 'rate_limit', retryable: true };
  if (
    /temporar|unavailable|try again|timed out|maintenance|busy|internal error|system error/.test(m)
  )
    return { category: 'provider_outage', retryable: true };
  if (/insufficient|not enough|low balance|balance/.test(m))
    return { category: 'quota', retryable: false };
  if (
    /not (found|exist)|does not exist|no such|not in your account|not belong|can ?not find/.test(m)
  )
    return { category: 'not_found', retryable: false };
  if (/already|not available|is taken|unavailable for registration|registered/.test(m))
    return { category: 'conflict', retryable: false };
  if (/lock|not unlocked|not allowed|prohibited|restrict/.test(m))
    return { category: 'validation', retryable: false };
  if (/invalid|required|must|incorrect|illegal|not valid|missing|format/.test(m))
    return { category: 'validation', retryable: false };
  return { category: 'unknown', retryable: false };
}

const STATE = (s: string | null): ProviderDomainState => {
  const v = (s ?? '').toLowerCase();
  if (v === 'active') return 'active';
  if (/redemption|pending delete/.test(v)) return 'redemption';
  if (/expire/.test(v)) return 'expired';
  if (/transfer/.test(v)) return 'transferring';
  if (/pending|process/.test(v)) return 'pending';
  if (/fail|cancel|problem/.test(v)) return 'failed';
  return 'unknown';
};

type Failure = {
  ok: false;
  status: 'failed' | 'uncertain';
  error: NormalizedError;
  ev: RawEvidence;
};
type Success = { ok: true; data: Obj; ev: RawEvidence };
type Params = Record<string, string | number | boolean | undefined>;

/** A year-only TLD list is not published as a query: `tld_price` is paged, and 500 entries per page covers the catalogue. */
const TLD_PAGE = 500;

export class DynadotAdapter implements RegistrarAdapter {
  readonly id = 'dynadot';
  readonly providerCode = 'dynadot';
  readonly kind = 'registrar' as const;
  readonly contractVersion = CONTRACT_VERSION;
  private priceCache: { at: number; byTld: Map<string, TldSupport> } | null = null;

  constructor(private readonly o: DynadotOptions) {}

  now(): string {
    return (this.o.now?.() ?? new Date()).toISOString();
  }
  private ev(operation: string, summary: string, req?: unknown, res?: unknown): RawEvidence {
    return {
      kind: this.o.evidenceKind,
      capturedAt: this.now(),
      operation,
      summary,
      redactedRequest: req,
      redactedResponse: res,
    };
  }
  private async creds(ctx: AccountContext) {
    if (!isVaultRef(ctx.credentialRef))
      throw new Error('credentialRef must be a vault:// reference');
    const m = await this.o.vault.resolve(ctx.credentialRef);
    return { m, apiKey: m.fields.apiKey ?? '' };
  }

  /** One Legacy API command. The answer is `{"<Name>Response": {ResponseCode, Status, Error?, …}}`; the node's fields are returned. */
  private async call(
    ctx: AccountContext,
    command: string,
    params: Params,
    opts: { mutating: boolean; op?: string },
  ): Promise<Success | Failure> {
    const c = await this.creds(ctx);
    const red = new Redactor().register(Object.values(c.m.fields));
    const op = opts.op ?? command;
    const fail = (status: 'failed' | 'uncertain', error: NormalizedError): Failure => ({
      ok: false,
      status,
      error,
      ev: this.ev(op, red.string(error.message), { command }, { providerCode: error.providerCode }),
    });
    const q = new URLSearchParams({ key: c.apiKey, command });
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.append(k, String(v));
    const url = `${this.o.baseUrl}/api3.json?${q.toString()}`;
    try {
      const res = await this.o.http.request({ method: 'GET', url, deadlineMs: ctx.deadlineMs });
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
      if (res.status === 429)
        return fail(
          'failed',
          normalizedError('rate_limit', 'rate_limit', 'the registrar rate limit was reached', true),
        );
      if (res.status >= 500)
        return fail(
          opts.mutating ? 'uncertain' : 'failed',
          normalizedError(
            'provider_outage',
            `http_${res.status}`,
            'the registrar had a server error',
            true,
          ),
        );
      const root = obj(json);
      // the documented envelope has one top-level node per command; a malformed key/command answers a bare node too
      const node = obj(
        Object.values(root).find((v) => v && typeof v === 'object' && !Array.isArray(v)) ?? root,
      );
      const header = obj(
        Object.values(node).find((v) => {
          const x = obj(v);
          return x.ResponseCode !== undefined || x.SuccessCode !== undefined;
        }),
      );
      const code = String(
        node.ResponseCode ??
          node.SuccessCode ??
          header.ResponseCode ??
          header.SuccessCode ??
          root.ResponseCode ??
          '',
      );
      const status = str(node.Status ?? header.Status ?? root.Status)?.toLowerCase() ?? '';
      const message = str(node.Error ?? header.Error ?? root.Error);
      if (code !== '' && code !== '0') {
        const k = classifyMessage(message ?? status);
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
      if (code === '' && (status === 'error' || message))
        return fail(
          'failed',
          normalizedError(
            'unknown',
            'unreadable',
            red.string(message ?? 'the registrar answer was not understood'),
          ),
        );
      return {
        ok: true,
        data: { ...header, ...node },
        ev: this.ev(op, `${command} ok`, { command }, { ok: true }),
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
  private cur(): Params {
    return this.o.currency ? { currency: this.o.currency } : {};
  }

  // ---- probe / health / catalogue -----------------------------------------------------------------------------------------------
  async probe(ctx: AccountContext): Promise<RegistrarCapabilityReport> {
    const caps: Partial<Record<RegistrarCapabilityId, CapabilityState>> = {};
    const ev: RawEvidence[] = [];
    const bal = await this.call(
      ctx,
      'get_account_balance',
      {},
      { mutating: false, op: 'probe.balance' },
    );
    ev.push(bal.ev);
    if (!bal.ok)
      return { capabilities: completeCapabilities({}), evidence: ev, probedAt: this.now() };
    const price = await this.call(
      ctx,
      'tld_price',
      { ...this.cur(), count_per_page: 1, page_index: 1 },
      { mutating: false, op: 'probe.tld-price' },
    );
    ev.push(price.ev);
    const s = await this.call(
      ctx,
      'search',
      { domain0: 'nuzm-probe-check.com', ...this.cur() },
      { mutating: false, op: 'probe.search' },
    );
    ev.push(s.ev);
    caps['registrar.search'] = s.ok ? 'supported' : 'unsupported';
    // register/renew/transfer/… cannot be proven without a side effect: derived from authenticated reads, exactly as the other registrar adapters do
    const base: CapabilityState = s.ok && price.ok ? 'supported' : 'unknown';
    for (const id of [
      'registrar.register',
      'registrar.renew',
      'registrar.transfer-in',
      'registrar.nameservers',
      'registrar.lock',
      'registrar.auth-code',
      'registrar.privacy',
      'registrar.find-by-token', // by DOMAIN NAME under our account: documented lookup, no client token exists
    ] as const)
      caps[id] = base;
    caps['registrar.contacts'] = 'unsupported'; // edit_contact exists but re-pointing a domain's contacts (set_whois) was not read in full
    caps['registrar.dns'] = 'unsupported'; // set_dns2 overwrites the zone wholesale with a few record types
    caps['registrar.dnssec'] = 'unknown';
    caps['registrar.eligibility'] = 'unsupported';
    caps['registrar.webhooks'] = 'unsupported'; // the Legacy API has none
    caps['registrar.billing-export'] = 'unsupported';
    return { capabilities: completeCapabilities(caps), evidence: ev, probedAt: this.now() };
  }

  async health(ctx: AccountContext): Promise<HealthReport> {
    const t0 = Date.now();
    const r = await this.call(ctx, 'get_account_balance', {}, { mutating: false, op: 'health' });
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

  private async tldMap(ctx: AccountContext): Promise<Map<string, TldSupport>> {
    if (this.priceCache && Date.now() - this.priceCache.at < 15 * 60_000)
      return this.priceCache.byTld;
    const r = await this.call(
      ctx,
      'tld_price',
      { ...this.cur(), count_per_page: TLD_PAGE, page_index: 1 },
      { mutating: false, op: 'tld-price' },
    );
    const byTld = new Map<string, TldSupport>();
    if (!r.ok) return byTld;
    const currency = (str(r.data.Currency) ?? this.o.currency ?? 'USD').toUpperCase();
    const list = Array.isArray(r.data.TldPrice) ? (r.data.TldPrice as unknown[]) : [];
    for (const raw of list) {
      const t = obj(raw);
      const tld = str(t.Tld)?.toLowerCase().replace(/^\./, '');
      if (!tld) continue;
      const price = obj(t.Price);
      const money = (v: unknown) => {
        const m = toMinorUnits(typeof v === 'string' || typeof v === 'number' ? v : null, currency);
        return m === null ? null : { amountMinor: m, currency };
      };
      const privacy = str(t.Privacy);
      const min = Number(t.minDuration);
      const max = Number(t.maxDuration);
      const restrictions = str(t.Restrictions);
      byTld.set(tld, {
        tld,
        register: 'supported',
        transfer: money(price.Transfer) ? 'supported' : 'unknown',
        renew: 'supported',
        dns: 'unsupported',
        privacy: privacy === null ? 'unknown' : privacy === '--' ? 'unsupported' : 'supported',
        dnssec: 'unknown',
        eligibilityRules: restrictions && restrictions !== '--' ? 'registry' : 'unknown',
        restricted: !!restrictions && restrictions !== '--',
        minYears: Number.isInteger(min) && min >= 1 ? min : 1,
        maxYears: Number.isInteger(max) && max >= 1 && max <= 10 ? max : 10,
        requiredContactFields: [],
        prices: {
          register: money(price.Register),
          renew: money(price.Renew),
          transfer: money(price.Transfer),
        },
      });
    }
    this.priceCache = { at: Date.now(), byTld };
    return byTld;
  }

  async supportedTlds(ctx: AccountContext): Promise<TldSupport[]> {
    return [...(await this.tldMap(ctx)).values()];
  }

  async search(
    ctx: AccountContext,
    names: string[],
    tlds: string[],
  ): Promise<AvailabilityResult[]> {
    const full = names.flatMap((n) => tlds.map((t) => ({ name: `${n}.${t}`, tld: t })));
    const batch = Math.min(Math.max(this.o.searchBatch ?? 1, 1), 100);
    const answers = new Map<string, { available: boolean | 'unknown'; premium: boolean }>();
    for (let i = 0; i < full.length; i += batch) {
      const chunk = full.slice(i, i + batch);
      const params: Params = { show_price: 1, ...this.cur() };
      chunk.forEach((d, k) => (params[`domain${k}`] = d.name));
      const r = await this.call(ctx, 'search', params, { mutating: false, op: 'search' });
      if (!r.ok) continue; // those names stay `unknown`: never available
      // one name answers as a flat object, several as a list (the documented example shows the list form)
      const rows = Array.isArray(r.data.SearchResults)
        ? (r.data.SearchResults as unknown[])
        : r.data.DomainName !== undefined
          ? [r.data]
          : [];
      for (const raw of rows) {
        const x = obj(raw);
        const dn = str(x.DomainName)?.toLowerCase();
        if (!dn) continue;
        const a = yes(x.Available);
        answers.set(dn, {
          available: a === null ? 'unknown' : a,
          premium: /premium/i.test(str(x.Price) ?? '') || /premium/i.test(str(x.Status) ?? ''),
        });
      }
    }
    const tldInfo = await this.tldMap(ctx);
    return full.map((d) => {
      const a = answers.get(d.name.toLowerCase());
      const info = tldInfo.get(d.tld.toLowerCase());
      const premium = a?.premium ?? false;
      // a premium name is priced individually by the vendor, so the per-TLD price is NOT its price: no price ⇒ not offered
      return {
        name: d.name,
        tld: d.tld,
        available: a?.available ?? 'unknown',
        premium,
        registerPrice: premium ? null : (info?.prices?.register ?? null),
        renewPrice: premium ? null : (info?.prices?.renew ?? null),
        transferPrice: premium ? null : (info?.prices?.transfer ?? null),
        cacheTtlSeconds: a ? 60 : 0,
        observedAt: this.now(),
      } satisfies AvailabilityResult;
    });
  }

  // ---- lookups ------------------------------------------------------------------------------------------------------------------
  private toRef(name: string, info: Obj, ns: string[]): DomainRef {
    const exp = Number(info.Expiration);
    const renew = str(info.RenewOption)?.toLowerCase() ?? '';
    const privacy = str(info.Privacy)?.toLowerCase() ?? '';
    return {
      providerRef: name, // Dynadot has no order/domain id for a domain: the name is the key within the account
      name,
      state: STATE(str(info.Status)),
      expiresAt: Number.isFinite(exp) && exp > 0 ? new Date(exp).toISOString() : null,
      nameservers: ns,
      locked: yes(info.Locked),
      autoRenew: /donot|do not|no renew/.test(renew) ? false : /auto/.test(renew) ? true : null,
      privacy: privacy === '' ? null : privacy === 'none' || privacy === 'off' ? 'off' : 'on',
    };
  }

  async inspect(ctx: AccountContext, name: string): Promise<OperationResult<DomainRef | null>> {
    const r = await this.call(
      ctx,
      'domain_info',
      { domain: name },
      { mutating: false, op: 'inspect' },
    );
    if (!r.ok) {
      // absence has no documented message: only a not_found-looking message is read as absent, anything else stays a failure (never "absent" by guess)
      return r.error.category === 'not_found'
        ? { status: 'succeeded', data: null, raw: r.ev }
        : { status: 'failed', error: r.error, raw: r.ev };
    }
    const info = obj(r.data.DomainInfo);
    const n = await this.call(
      ctx,
      'get_ns',
      { domain: name },
      { mutating: false, op: 'inspect.ns' },
    );
    const ns = n.ok
      ? Object.entries(obj(n.data.NsContent))
          .filter(([k]) => /^Host\d+$/.test(k))
          .sort(([a], [b]) => Number(a.slice(4)) - Number(b.slice(4)))
          .map(([, v]) => str(v))
          .filter((x): x is string => !!x)
      : [];
    const ref = this.toRef(name, info, ns);
    return { status: 'succeeded', providerRef: ref.providerRef, data: ref, raw: r.ev };
  }

  async findByToken(
    ctx: AccountContext,
    token: string,
    hint: { name: string },
  ): Promise<OperationResult<DomainRef | null>> {
    void token; // the vendor has no client token: the name under our account is the key
    const d = await this.inspect(ctx, hint.name);
    if (d.status !== 'succeeded') return { status: 'uncertain', error: d.error, raw: d.raw };
    if (!d.data)
      return {
        status: 'succeeded',
        data: null,
        raw: this.ev('findByToken', 'absent: no domain of this name under our account'),
      };
    return { status: 'succeeded', data: d.data, providerRef: d.data.providerRef, raw: d.raw };
  }

  // ---- contacts / register / transfer / renew ---------------------------------------------------------------------------------
  private async contactIds(
    ctx: AccountContext,
    contacts: ContactSet,
  ): Promise<{ ok: true; ids: Record<string, string> } | Failure> {
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
          'create_contact',
          {
            name: `${p.firstName} ${p.lastName}`,
            organization: p.organization,
            email: p.email,
            phonecc: m?.[1] ?? '0',
            phonenum: m?.[2] ?? p.phone.replace(/\D/g, ''),
            address1: p.address.street,
            city: p.address.city,
            state: p.address.state,
            zip: p.address.postalCode,
            country: p.address.country,
          },
          { mutating: true, op: 'contacts.create' },
        );
        if (!r.ok) return r;
        const got = str(obj(r.data.CreateContactContent).ContactId) ?? str(r.data.ContactId);
        if (got === null)
          return {
            ok: false,
            status: 'uncertain',
            error: normalizedError(
              'unknown',
              'unreadable',
              'the registrar did not return a contact id',
            ),
            ev: r.ev,
          };
        id = got;
        byKey.set(key, id);
      }
      ids[role] = id;
    }
    return { ok: true, ids };
  }

  private pendingRef(name: string, state: 'pending' | 'transferring'): DomainRef {
    return {
      providerRef: name,
      name,
      state,
      expiresAt: null,
      nameservers: [],
      locked: null,
      autoRenew: null,
      privacy: null,
    };
  }

  /** After an accepted order: read it back; a domain not yet readable is still an accepted order, never a failure. */
  private async afterAction(
    ctx: AccountContext,
    name: string,
    ev: RawEvidence,
    pending: 'pending' | 'transferring',
  ): Promise<OperationResult<DomainRef>> {
    const d = await this.inspect(ctx, name);
    if (d.status === 'succeeded' && d.data) {
      const done = d.data.state === 'active';
      return {
        status: done ? 'succeeded' : 'accepted',
        providerRef: d.data.providerRef,
        data: done ? d.data : { ...d.data, state: pending },
        raw: ev,
      };
    }
    return { status: 'accepted', providerRef: name, data: this.pendingRef(name, pending), raw: ev };
  }

  async register(ctx: AccountContext, req: RegisterRequest): Promise<OperationResult<DomainRef>> {
    const prior = await this.findByToken(ctx, req.idempotencyToken, { name: req.name });
    if (prior.status === 'succeeded' && prior.data)
      return {
        status: prior.data.state === 'active' ? 'succeeded' : 'accepted',
        providerRef: prior.data.providerRef,
        data: prior.data,
        raw: this.ev('register', 'already registered under our account'),
      };
    if (prior.status !== 'succeeded')
      return { status: 'uncertain', error: prior.error, raw: prior.raw };
    const ids = await this.contactIds(ctx, req.contacts);
    if (!ids.ok) return this.res(ids);
    const r = await this.call(
      ctx,
      'register',
      {
        domain: req.name,
        duration: req.years,
        registrant_contact: ids.ids.registrant,
        admin_contact: ids.ids.admin,
        technical_contact: ids.ids.tech,
        billing_contact: ids.ids.billing,
        ...this.cur(),
      },
      { mutating: true, op: 'register' },
    );
    if (!r.ok) return this.res(r);
    // settings that are separate commands in this API; the registration stands even if one of them is refused (the next inspect shows the real state)
    if (req.nameservers?.length) await this.setNameservers(ctx, req.name, req.nameservers);
    if (req.privacy)
      await this.call(
        ctx,
        'set_privacy',
        { domain: req.name, option: 'full', whois_privacy_option: 'yes' },
        { mutating: true, op: 'register.privacy' },
      );
    await this.call(
      ctx,
      'set_renew_option',
      { domain: req.name, renew_option: req.autoRenew ? 'auto' : 'donot' },
      { mutating: true, op: 'register.renewOption' },
    );
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
        raw: this.ev('transferIn', 'already under our account'),
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
    const ids = await this.contactIds(ctx, req.contacts);
    if (!ids.ok) return this.res(ids);
    const r = await this.call(
      ctx,
      'transfer',
      {
        domain: req.name,
        auth: code,
        registrant_contact: ids.ids.registrant,
        admin_contact: ids.ids.admin,
        technical_contact: ids.ids.tech,
        billing_contact: ids.ids.billing,
        privacy: req.privacy ? 'on' : 'off',
        name_servers: req.nameservers?.length ? req.nameservers.join(',') : undefined,
        ...this.cur(),
      },
      { mutating: true, op: 'transferIn' },
    );
    if (!r.ok) return this.res(r);
    return {
      status: 'accepted',
      providerRef: req.name,
      data: this.pendingRef(req.name, 'transferring'),
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
      'renew',
      {
        domain: req.name,
        duration: req.years,
        // the documented `year` guard: the renewal applies to the year the domain currently expires
        year: cur.data.expiresAt ? new Date(cur.data.expiresAt).getUTCFullYear() : undefined,
        ...this.cur(),
      },
      { mutating: true, op: 'renew' },
    );
    if (!r.ok) return this.res(r);
    const after = await this.inspect(ctx, req.name);
    return { status: 'succeeded', providerRef: req.name, data: after.data ?? cur.data, raw: r.ev };
  }

  // ---- changes on an existing domain ----------------------------------------------------------------------------------------------
  private async existing(
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
  private async changed(
    ctx: AccountContext,
    name: string,
    before: DomainRef,
    ev: RawEvidence,
  ): Promise<OperationResult<DomainRef>> {
    const after = await this.inspect(ctx, name);
    return {
      status: 'succeeded',
      providerRef: before.providerRef,
      data: after.data ?? before,
      raw: ev,
    };
  }

  async setNameservers(
    ctx: AccountContext,
    name: string,
    nameservers: string[],
  ): Promise<OperationResult<DomainRef>> {
    const o = await this.existing(ctx, name);
    if (!o.ok) return o.res;
    // set_ns only accepts name servers that already exist in the account: add each first (an "already exists" answer is fine)
    for (const host of nameservers) {
      const a = await this.call(
        ctx,
        'add_ns',
        { host },
        { mutating: true, op: 'setNameservers.add' },
      );
      if (!a.ok && a.error.category !== 'conflict' && !/exist|already/i.test(a.error.message))
        return this.res(a);
    }
    const params: Params = { domain: name };
    nameservers.slice(0, 13).forEach((h, i) => (params[`ns${i}`] = h));
    const r = await this.call(ctx, 'set_ns', params, { mutating: true, op: 'setNameservers' });
    if (!r.ok) return this.res(r);
    return this.changed(ctx, name, o.ref, r.ev);
  }

  async setLock(
    ctx: AccountContext,
    name: string,
    locked: boolean,
  ): Promise<OperationResult<DomainRef>> {
    const o = await this.existing(ctx, name);
    if (!o.ok) return o.res;
    const r = await this.call(
      ctx,
      locked ? 'lock_domain' : 'unlock_domain',
      { domain: name },
      { mutating: true, op: 'setLock' },
    );
    if (!r.ok) return this.res(r);
    return this.changed(ctx, name, o.ref, r.ev);
  }

  async setAutoRenew(
    ctx: AccountContext,
    name: string,
    autoRenew: boolean,
  ): Promise<OperationResult<DomainRef>> {
    const o = await this.existing(ctx, name);
    if (!o.ok) return o.res;
    const r = await this.call(
      ctx,
      'set_renew_option',
      { domain: name, renew_option: autoRenew ? 'auto' : 'donot' },
      { mutating: true, op: 'setAutoRenew' },
    );
    if (!r.ok) return this.res(r);
    return this.changed(ctx, name, o.ref, r.ev);
  }

  async setContacts(
    _c: AccountContext,
    _n: string,
    _x: ContactSet,
  ): Promise<OperationResult<DomainRef>> {
    return this.unsupported(
      'setContacts',
      'changing the contacts of an existing domain (set_whois was not read in full)',
    );
  }

  async authCode(
    ctx: AccountContext,
    name: string,
    store: AuthCodeStore,
  ): Promise<OperationResult<{ authCodeRef: string }>> {
    // documented precondition: "You must unlock your domain and account before requesting auth code" — the caller unlocks first (setLock)
    const r = await this.call(
      ctx,
      'get_transfer_auth_code',
      { domain: name },
      { mutating: false, op: 'authCode' },
    );
    if (!r.ok) return this.res(r);
    const code = str(r.data.AuthCode);
    if (!code)
      return {
        status: 'failed',
        error: normalizedError(
          'unknown',
          'unreadable',
          'the registrar returned no authorization code',
        ),
        raw: r.ev,
      };
    const ref = await store.put(code, `dynadot-${name}`);
    return { status: 'succeeded', data: { authCodeRef: ref }, raw: r.ev };
  }
}
