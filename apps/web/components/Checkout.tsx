'use client';
import { useEffect, useRef, useState } from 'react';
import { formatMinor, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, ButtonLink, EmptyState, Field, Icon, Input, Select } from '@nuzm/ui';
import { totals, type CartLine, type HostingLine } from '../lib/cart';
import { clearCart, removeFromCart, useCart } from '../lib/cart-client';
import { errorText } from '../lib/actions';
import { browserApi } from '../lib/client';
import { memoryLabel } from '../lib/compute';
import { typeOfPlan, type CatalogPlan } from '../lib/hosting-catalog';
import { NoticeText } from './Feedback';

export interface CheckoutMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}
interface Quote {
  id: string;
  currency: string;
  subtotalMinor: string;
  totalMinor: string;
  expiresAt: string;
  taxEstimate: { taxMinor: string };
}
interface Detail {
  name: string;
  runtime: string;
  domain: string;
}
type Step = 'details' | 'payment' | 'review';
const STEPS: Step[] = ['details', 'payment', 'review'];
const key = () => crypto.randomUUID();
const code = (r: { error?: unknown }) => (r.error as { code?: string } | undefined)?.code;
const money = (minor: string, currency: string, locale: Locale): string => {
  try {
    return formatMinor(minor, currency, locale);
  } catch {
    return `${minor} ${currency}`;
  }
};
const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const DOMAIN = /^$|^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The checkout of the basket. Hosting websites are completed here in three steps (details, card, review) and become real sites through the same quote
 * and site calls as "add a website"; domains and cloud servers continue in their own order step. The final price is always the API's quote, never the
 * basket's running total.
 */
export function Checkout(p: {
  locale: Locale;
  orgId: string;
  plans: CatalogPlan[];
  projects: { id: string; name: string }[];
  methods: CheckoutMethod[];
  canSites: boolean;
  canAddCard: boolean;
  sandbox: boolean;
}) {
  const { locale, orgId } = p;
  const { lines, ready } = useCart(orgId);
  // the result of placing the websites must stay on screen even though the created ones have left the basket
  const [showResults, setShowResults] = useState(false);
  const hosting = lines.filter((l): l is HostingLine => l.kind === 'hosting');
  const domains = lines.filter((l) => l.kind === 'domain');
  const servers = lines.filter((l) => l.kind === 'server');
  if (!ready) return null;
  if (lines.length === 0 && !showResults)
    return (
      <EmptyState
        title={t(locale, 'checkout.empty.title')}
        body={t(locale, 'checkout.empty.body')}
        action={
          <ButtonLink href={`/${locale}/hosting/plans`}>
            {t(locale, 'checkout.empty.action')}
          </ButtonLink>
        }
      />
    );
  const tot = totals(lines);
  return (
    <div className="nzc-co">
      <div className="nzc-co-main">
        {domains.length > 0 && (
          <section className="nzc-co-card" aria-labelledby="co-dom">
            <h2 id="co-dom">{t(locale, 'checkout.domains.title')}</h2>
            <p className="nz-muted">{t(locale, 'checkout.domains.sub')}</p>
            {domains.map(
              (l) =>
                l.kind === 'domain' && (
                  <div key={l.id} className="nzc-co-line">
                    <div className="nzc-co-line-head">
                      <b dir="ltr">{l.domain}</b>
                      <span className="nzc-co-line-price" dir="ltr">
                        {l.priceMinor && l.currency
                          ? t(locale, 'checkout.domains.perYear', {
                              price: money(l.priceMinor, l.currency, locale),
                            })
                          : '—'}
                      </span>
                    </div>
                    <div className="nzc-co-foot">
                      <ButtonLink
                        href={`/${locale}/domains/checkout?name=${encodeURIComponent(l.domain)}&years=${l.years}&cart=${l.id}`}
                      >
                        {t(locale, 'checkout.domains.continue')}
                      </ButtonLink>
                      <Button variant="secondary" onClick={() => removeFromCart(orgId, l.id)}>
                        {t(locale, 'checkout.line.remove')}
                      </Button>
                    </div>
                  </div>
                ),
            )}
          </section>
        )}
        {servers.length > 0 && (
          <section className="nzc-co-card" aria-labelledby="co-srv">
            <h2 id="co-srv">{t(locale, 'checkout.servers.title')}</h2>
            <p className="nz-muted">{t(locale, 'checkout.servers.sub')}</p>
            {servers.map(
              (l) =>
                l.kind === 'server' && (
                  <div key={l.id} className="nzc-co-line">
                    <div className="nzc-co-line-head">
                      <b>
                        {t(locale, `cloud.family.${l.family}` as MessageKey)} ·{' '}
                        {t(locale, 'm05.web.plan.summary', {
                          vcpu: l.vcpu,
                          memory: memoryLabel(l.memoryMb),
                        })}
                      </b>
                      <span className="nz-muted">{l.imageName}</span>
                      <span className="nzc-co-line-price" dir="ltr">
                        {l.priceMinor && l.currency
                          ? t(locale, 'checkout.review.perMonth', {
                              price: money(l.priceMinor, l.currency, locale),
                            })
                          : '—'}
                      </span>
                    </div>
                    <div className="nzc-co-foot">
                      <ButtonLink
                        href={`/${locale}/compute/instances/new?offerId=${l.offerId}&image=${l.imageId}&cart=${l.id}`}
                      >
                        {t(locale, 'checkout.servers.continue')}
                      </ButtonLink>
                      <Button variant="secondary" onClick={() => removeFromCart(orgId, l.id)}>
                        {t(locale, 'checkout.line.remove')}
                      </Button>
                    </div>
                  </div>
                ),
            )}
          </section>
        )}
        {(hosting.length > 0 || showResults) && p.canSites && (
          <HostingFlow
            onResults={() => setShowResults(true)}
            locale={locale}
            orgId={orgId}
            lines={hosting}
            plans={p.plans}
            projects={p.projects}
            methods={p.methods}
            canAddCard={p.canAddCard}
            sandbox={p.sandbox}
          />
        )}
      </div>
      <aside className="nzc-co-sum" aria-label={t(locale, 'cart.title')}>
        <h2>{t(locale, 'cart.title')}</h2>
        <dl>
          {lines.map((l) => (
            <div key={l.id}>
              <dt>{lineName(l, locale)}</dt>
              <dd dir="ltr">
                {l.priceMinor && l.currency ? money(l.priceMinor, l.currency, locale) : '—'}
              </dd>
            </div>
          ))}
        </dl>
        <dl className="nzc-co-total">
          <div>
            <dt>{t(locale, 'cart.total')}</dt>
            <dd dir="ltr">
              {tot.currency && tot.knownMinor > 0n
                ? money(tot.knownMinor.toString(), tot.currency, locale)
                : '—'}
            </dd>
          </div>
        </dl>
        {tot.unpriced > 0 && tot.knownMinor > 0n && (
          <p className="nzc-cart-note">{t(locale, 'cart.unpriced', { n: tot.unpriced })}</p>
        )}
        <p className="nzc-cart-note">{t(locale, 'cart.beforeVat')}</p>
        <button type="button" className="nzc-cart-clear" onClick={() => clearCart(orgId)}>
          {t(locale, 'cart.clear')}
        </button>
      </aside>
    </div>
  );
}

function lineName(l: CartLine, locale: Locale): string {
  if (l.kind === 'hosting') return l.name[locale];
  if (l.kind === 'domain') return l.domain;
  return `${t(locale, `cloud.family.${l.family}` as MessageKey)} · ${l.vcpu} vCPU`;
}

function HostingFlow(p: {
  /** Told when the websites were placed, so the page keeps this section (and its result) on screen. */
  onResults: () => void;
  locale: Locale;
  orgId: string;
  lines: HostingLine[];
  plans: CatalogPlan[];
  projects: { id: string; name: string }[];
  methods: CheckoutMethod[];
  canAddCard: boolean;
  sandbox: boolean;
}) {
  const { locale, orgId } = p;
  const planOf = (l: HostingLine) => p.plans.find((x) => x.id === l.planId);
  const [step, setStep] = useState<Step>('details');
  const [projectId, setProjectId] = useState(p.projects[0]?.id ?? '');
  const [details, setDetails] = useState<Record<string, Detail>>({});
  const [methodId, setMethodId] = useState(
    p.methods.find((m) => m.isDefault)?.id ?? p.methods[0]?.id ?? '',
  );
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [lineErr, setLineErr] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }> | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  const quoteKeys = useRef<Record<string, string>>({});
  const createKeys = useRef<Record<string, string>>({});
  const draftKey = `nuzm_checkout:${orgId}`;

  // the details survive the trip to "add a card" and back (this tab only; nothing secret is kept)
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw) as { projectId?: string; details?: Record<string, Detail> };
        if (d.details) setDetails(d.details);
        if (d.projectId && p.projects.some((x) => x.id === d.projectId)) setProjectId(d.projectId);
      }
    } catch {
      /* no draft */
    }
  }, [draftKey, p.projects]);
  // saved when a field CHANGES (not in an effect: React's development double-run would overwrite the draft with an empty one before it is restored)
  const persist = (nextProject: string, nextDetails: Record<string, Detail>) => {
    try {
      window.sessionStorage.setItem(
        draftKey,
        JSON.stringify({ projectId: nextProject, details: nextDetails }),
      );
    } catch {
      /* the draft is a convenience */
    }
  };
  useEffect(() => {
    if (step !== 'review') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  const detailOf = (l: HostingLine): Detail =>
    details[l.id] ?? {
      name: '',
      runtime: planOf(l)?.runtimes[0] ?? l.runtimes[0] ?? '',
      domain: '',
    };
  const setDetail = (l: HostingLine, patch: Partial<Detail>) => {
    const next = { ...details, [l.id]: { ...detailOf(l), ...patch } };
    setDetails(next);
    persist(projectId, next);
  };

  const gone = p.lines.filter((l) => !planOf(l));
  const method = p.methods.find((m) => m.id === methodId);
  const quoted = p.lines.every((l) => quotes[l.id]);
  const expiry = quoted ? Math.min(...p.lines.map((l) => Date.parse(quotes[l.id]!.expiresAt))) : 0;
  const left = quoted ? Math.max(0, Math.floor((expiry - now) / 1000)) : 0;
  const expired = quoted && left === 0;

  function toPayment() {
    const errs: Record<string, string> = {};
    for (const l of p.lines) {
      const d = detailOf(l);
      if (!planOf(l)) errs[l.id] = t(locale, 'checkout.line.gone');
      else if (!d.name.trim() || d.name.trim().length > 63 || !d.runtime)
        errs[l.id] = t(locale, 'err.validation');
      else if (!DOMAIN.test(d.domain.trim().toLowerCase()))
        errs[l.id] = t(locale, 'err.validation');
    }
    setLineErr(errs);
    if (!projectId) return setN({ tone: 'error', text: t(locale, 'host.new.noProjects') });
    setN(null);
    if (Object.keys(errs).length === 0) setStep('payment');
  }

  async function getQuotes() {
    setBusy(true);
    setN(null);
    const next: Record<string, Quote> = {};
    const errs: Record<string, string> = {};
    for (const l of p.lines) {
      const d = detailOf(l);
      quoteKeys.current[l.id] = key();
      const r = await browserApi().POST('/v1/quotes', {
        params: { header: { 'Idempotency-Key': quoteKeys.current[l.id]! } },
        body: { kind: 'hosting', items: [{ planId: l.planId, runtime: d.runtime }] } as never,
      });
      if (r.response.ok && r.data) next[l.id] = r.data as unknown as Quote;
      else errs[l.id] = reason(code(r), r.response.status);
    }
    setBusy(false);
    setQuotes(next);
    setLineErr(errs);
    if (Object.keys(errs).length) setN({ tone: 'error', text: t(locale, 'state.error.title') });
  }

  const reason = (c: string | undefined, status: number): string =>
    c === 'no_capacity'
      ? t(locale, 'host.new.noCapacity')
      : c === 'quota_exceeded'
        ? t(locale, 'host.new.quota')
        : c === 'unsupported_runtime'
          ? t(locale, 'host.new.runtimeBad')
          : c === 'kind_not_available'
            ? t(locale, 'checkout.line.gone')
            : errorText(locale, status, c);

  async function confirm() {
    setBusy(true);
    setN(null);
    const out: Record<string, { ok: boolean; text: string }> = {};
    for (const l of p.lines) {
      const q = quotes[l.id]!;
      const d = detailOf(l);
      createKeys.current[q.id] ??= key();
      const r = await browserApi().POST('/v1/hosting/sites', {
        params: { header: { 'Idempotency-Key': createKeys.current[q.id]! } },
        body: {
          quoteId: q.id,
          planId: l.planId,
          name: d.name.trim(),
          projectId,
          runtime: d.runtime,
          ...(d.domain.trim() ? { primaryDomain: d.domain.trim().toLowerCase() } : {}),
        },
      });
      if (r.response.ok) {
        out[l.id] = { ok: true, text: t(locale, 'checkout.done.ok', { name: d.name.trim() }) };
        removeFromCart(orgId, l.id); // created: it leaves the basket, the rest stay if they failed
      } else
        out[l.id] = {
          ok: false,
          text: t(locale, 'checkout.done.failed', {
            name: d.name.trim(),
            reason: reason(code(r), r.response.status),
          }),
        };
    }
    setBusy(false);
    setResults(out);
    p.onResults();
    if (Object.values(out).every((x) => x.ok)) {
      try {
        window.sessionStorage.removeItem(draftKey);
      } catch {
        /* nothing to clear */
      }
    }
  }

  if (results)
    return (
      <section className="nzc-co-card" aria-labelledby="co-done">
        <h2 id="co-done">{t(locale, 'checkout.done.title')}</h2>
        <ul className="nzc-co-done">
          {Object.entries(results).map(([id, r]) => (
            <li key={id} role={r.ok ? 'status' : 'alert'}>
              <Icon name={r.ok ? 'check' : 'close'} size={16} />
              {r.text}
            </li>
          ))}
        </ul>
        {Object.values(results).some((r) => !r.ok) && (
          <p className="nz-muted">{t(locale, 'checkout.done.retry')}</p>
        )}
        <div className="nzc-co-foot">
          <ButtonLink href={`/${locale}/hosting/sites`}>{t(locale, 'checkout.done.go')}</ButtonLink>
        </div>
      </section>
    );

  return (
    <section className="nzc-co-card" aria-labelledby="co-host">
      <h2 id="co-host">{t(locale, 'checkout.hosting.title')}</h2>
      <ol className="nzc-co-steps" aria-label={t(locale, 'checkout.steps')}>
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? 'step' : undefined}
            data-done={STEPS.indexOf(step) > i ? 'true' : undefined}
          >
            <i aria-hidden="true">{i + 1}</i>
            {t(locale, `checkout.step.${s}` as MessageKey)}
          </li>
        ))}
      </ol>

      {step === 'details' && (
        <>
          <h3>{t(locale, 'checkout.details.title')}</h3>
          <Field id="co-project" label={t(locale, 'checkout.details.project')}>
            {(x) => (
              <Select
                {...x}
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                  persist(e.target.value, details);
                }}
              >
                {p.projects.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {p.lines.map((l) => {
            const d = detailOf(l);
            const plan = planOf(l);
            return (
              <div key={l.id} className="nzc-co-line">
                <div className="nzc-co-line-head">
                  <b>{l.name[locale]}</b>
                  <span className="nz-muted">
                    {t(locale, `host.type.${typeOfPlan(l.key)}` as MessageKey)}
                  </span>
                  <span className="nzc-co-line-price" dir="ltr">
                    {l.priceMinor && l.currency
                      ? t(locale, 'checkout.review.perMonth', {
                          price: money(l.priceMinor, l.currency, locale),
                        })
                      : '—'}
                  </span>
                </div>
                {!plan ? (
                  <p className="nz-error-text" role="alert">
                    {t(locale, 'checkout.line.gone')}
                  </p>
                ) : (
                  <div className="nzc-co-fields">
                    <Field id={`co-n-${l.id}`} label={t(locale, 'checkout.line.name')}>
                      {(x) => (
                        <Input
                          {...x}
                          maxLength={63}
                          value={d.name}
                          onChange={(e) => setDetail(l, { name: e.target.value })}
                        />
                      )}
                    </Field>
                    <Field id={`co-r-${l.id}`} label={t(locale, 'checkout.line.runtime')}>
                      {(x) => (
                        <Select
                          {...x}
                          dir="ltr"
                          value={d.runtime}
                          onChange={(e) => setDetail(l, { runtime: e.target.value })}
                        >
                          {plan.runtimes.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field id={`co-d-${l.id}`} label={t(locale, 'checkout.line.domain')}>
                      {(x) => (
                        <Input
                          {...x}
                          dir="ltr"
                          placeholder="example.com"
                          spellCheck={false}
                          value={d.domain}
                          onChange={(e) => setDetail(l, { domain: e.target.value })}
                        />
                      )}
                    </Field>
                  </div>
                )}
                {lineErr[l.id] && (
                  <span className="nz-error-text" role="alert">
                    {lineErr[l.id]}
                  </span>
                )}
                <div>
                  <Button variant="secondary" onClick={() => removeFromCart(orgId, l.id)}>
                    {t(locale, 'checkout.line.remove')}
                  </Button>
                </div>
              </div>
            );
          })}
          <NoticeText notice={n} />
          <div className="nzc-co-foot">
            <Button onClick={toPayment} disabled={gone.length > 0}>
              {t(locale, 'action.next')}
            </Button>
          </div>
        </>
      )}

      {step === 'payment' && (
        <>
          <h3>{t(locale, 'checkout.payment.title')}</h3>
          <p className="nz-muted">{t(locale, 'checkout.payment.sub')}</p>
          {p.methods.length === 0 ? (
            <p role="status">{t(locale, 'checkout.payment.none')}</p>
          ) : (
            <div
              className="nzc-co-methods"
              role="radiogroup"
              aria-label={t(locale, 'checkout.payment.title')}
            >
              {p.methods.map((m) => (
                <label key={m.id} className="nzc-co-method">
                  <input
                    type="radio"
                    name="co-method"
                    value={m.id}
                    checked={methodId === m.id}
                    onChange={() => setMethodId(m.id)}
                  />
                  <span>
                    <b style={{ textTransform: 'capitalize' }}>{m.brand}</b>{' '}
                    <span dir="ltr">•••• {m.last4}</span>
                    <br />
                    <small>
                      {t(locale, 'checkout.payment.expires', {
                        month: String(m.expMonth).padStart(2, '0'),
                        year: m.expYear,
                      })}
                    </small>
                  </span>
                  {m.isDefault && <Badge>{t(locale, 'checkout.payment.default')}</Badge>}
                </label>
              ))}
            </div>
          )}
          {p.canAddCard && (
            <div className="nzc-co-foot">
              <ButtonLink
                variant="secondary"
                href={`/${locale}/billing/payment-methods/add?next=${encodeURIComponent(`/${locale}/checkout`)}`}
              >
                <Icon name="plus" size={16} /> {t(locale, 'checkout.payment.add')}
              </ButtonLink>
            </div>
          )}
          {p.sandbox && <p className="nz-muted">{t(locale, 'checkout.payment.note')}</p>}
          <div className="nzc-co-foot">
            <Button variant="secondary" onClick={() => setStep('details')}>
              {t(locale, 'm05.web.wiz.back')}
            </Button>
            <Button onClick={() => setStep('review')} disabled={!method}>
              {t(locale, 'action.next')}
            </Button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          <h3>{t(locale, 'checkout.review.title')}</h3>
          {method && (
            <p className="nz-muted">
              {t(locale, 'checkout.review.card', { brand: method.brand, last4: method.last4 })}
            </p>
          )}
          {p.lines.map((l) => {
            const q = quotes[l.id];
            const d = detailOf(l);
            return (
              <div key={l.id} className="nzc-co-line">
                <div className="nzc-co-line-head">
                  <b>{l.name[locale]}</b>
                  <span className="nz-muted" dir="ltr">
                    {d.name} · {d.runtime}
                  </span>
                  <span className="nzc-co-line-price" dir="ltr">
                    {q ? money(q.subtotalMinor, q.currency, locale) : '—'}
                  </span>
                </div>
                {lineErr[l.id] && (
                  <span className="nz-error-text" role="alert">
                    {lineErr[l.id]}
                  </span>
                )}
              </div>
            );
          })}
          {quoted && (
            <dl className="nzc-co-sum" style={{ position: 'static' }}>
              {(() => {
                const cur = quotes[p.lines[0]!.id]!.currency;
                const sum = (f: (q: Quote) => string) =>
                  p.lines.reduce((a, l) => a + BigInt(f(quotes[l.id]!)), 0n).toString();
                return (
                  <>
                    <div>
                      <dt>{t(locale, 'bill.f.subtotal')}</dt>
                      <dd dir="ltr">
                        {money(
                          sum((q) => q.subtotalMinor),
                          cur,
                          locale,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t(locale, 'bill.f.tax')}</dt>
                      <dd dir="ltr">
                        {money(
                          sum((q) => q.taxEstimate.taxMinor),
                          cur,
                          locale,
                        )}
                      </dd>
                    </div>
                    <div className="nzc-co-total">
                      <dt>{t(locale, 'bill.f.total')}</dt>
                      <dd dir="ltr">
                        {money(
                          sum((q) => q.totalMinor),
                          cur,
                          locale,
                        )}
                      </dd>
                    </div>
                  </>
                );
              })()}
            </dl>
          )}
          {quoted && (
            <p className={expired ? 'nz-error-text' : 'nz-muted'} role="status">
              {expired
                ? t(locale, 'checkout.review.expired')
                : t(locale, 'checkout.review.valid', { time: mmss(left) })}{' '}
              {t(locale, 'checkout.review.vat')}
            </p>
          )}
          <NoticeText notice={n} />
          <div className="nzc-co-foot">
            <Button variant="secondary" onClick={() => setStep('payment')} disabled={busy}>
              {t(locale, 'm05.web.wiz.back')}
            </Button>
            {!quoted || expired ? (
              <Button onClick={() => void getQuotes()} disabled={busy}>
                {quoted ? t(locale, 'checkout.review.renew') : t(locale, 'checkout.review.get')}
              </Button>
            ) : (
              <Button onClick={() => void confirm()} disabled={busy}>
                {busy ? t(locale, 'checkout.working') : t(locale, 'checkout.confirm')}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
