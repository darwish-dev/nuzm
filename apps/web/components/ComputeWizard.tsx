'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  EmptyState,
  Field,
  Icon,
  Input,
  Ltr,
  Table,
} from '@nuzm/ui';
import { familiesIn, familyOf, regionsOf, selectionFor, sizesFor } from '../lib/cloud-config';
import { CART_MAX } from '../lib/cart';
import { addServerToCart, removeFromCart } from '../lib/cart-client';
import { browserCompute } from '../lib/compute-client';
import { useComputeAction } from '../lib/compute-actions';
import {
  MAX_SSH_KEYS,
  isImageId,
  isInstanceName,
  isQuoteExpired,
  memoryLabel,
  moneyText,
  parseDiskGb,
  parseSshKeys,
  queryString,
  residencyOf,
  secondsLeft,
  type Offer,
  type Quote,
} from '../lib/compute';
import { ProblemAlert } from './ComputeBits';
import { regionLabel } from './ComputeOffers';
import { NoticeText } from './Feedback';

type Step = 'configure' | 'keys' | 'review';
const STEPS: Step[] = ['configure', 'keys', 'review'];

interface OsImage {
  id: string;
  name: string;
  osFamily: string | null;
  /** HestiaCP can be installed on this image (verified for it, sold placement): the control-panel choice appears only then */
  hestia?: boolean;
}
/** Country name in the page language (ISO code as the fallback). */
const countryName = (locale: Locale, code: string): string => {
  try {
    return (
      new Intl.DisplayNames([locale === 'ar' ? 'ar-SA' : 'en'], { type: 'region' }).of(code) ?? code
    );
  } catch {
    return code;
  }
};
/** Problems after which the quote cannot be used any more: the user must get a fresh one. */
const STALE = new Set(['quote_expired', 'quote_consumed', 'price_changed']);

const mmss = (s: number): string =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/**
 * UI-M05-02: configure (region → Nuzm Cloud line → size → operating system → name, with the monthly price as you go) → SSH keys → quote review
 * (cost, tax estimate, residency result) → confirm.
 * The quote is immutable and short-lived (15 min): the review shows a countdown and, once it ran out (or the API says quote_expired /
 * quote_consumed / price_changed), blocks confirming and offers a fresh quote. The Idempotency-Key of the create call belongs to the
 * quote, so a double click or a retry after an uncertain answer can never create a second instance.
 */
export function ComputeWizard(p: {
  locale: Locale;
  offers: Offer[];
  /** The organization whose basket "Add to cart" fills (omit to hide the button). */
  orgId?: string;
  /** The basket line this order finishes: the line is removed once the server is created. */
  basketLineId?: string;
  /** The operating system chosen before the basket (preselected when it is still offered). */
  initialImageId?: string;
  initialOfferId?: string;
  mfaFactorId: string | null;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useComputeAction(locale, p.mfaFactorId);
  const [step, setStep] = useState<Step>('configure');
  const [sel, setSel] = useState(() =>
    selectionFor(p.offers, p.initialOfferId ? { offerId: p.initialOfferId } : {}),
  );
  const offerId = sel?.offerId ?? '';
  const [imageId, setImageId] = useState('');
  const wantImage = useRef(p.initialImageId ?? '');
  const [carted, setCarted] = useState<'idle' | 'added' | 'full'>('idle');
  const [images, setImages] = useState<{
    for: string;
    state: 'loading' | 'ok' | 'error';
    items: OsImage[];
  }>({
    for: '',
    state: 'loading',
    items: [],
  });
  const [name, setName] = useState('');
  // control panel (S04): none by default; with HestiaCP the mail service is an EXPLICIT yes/no answer (no default)
  const [panel, setPanel] = useState<'none' | 'hestia'>('none');
  const [mail, setMail] = useState<'' | 'yes' | 'no'>('');
  const [disk, setDisk] = useState('');
  const [keysText, setKeysText] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const createKey = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);
  const offer = p.offers.find((o) => o.offerId === offerId);
  const hestiaOk = images.items.find((i) => i.id === imageId)?.hestia === true;
  const hestiaOn = panel === 'hestia' && hestiaOk;

  // move focus to the step heading only when the step CHANGES (not on first load, where it would draw a focus ring around the title)
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) firstStep.current = false;
    else heading.current?.focus();
  }, [step]);
  // the operating systems of the chosen size (customer-safe list: id, name, family); a new size clears the previous choice
  useEffect(() => {
    if (!offerId) return;
    let live = true;
    setImageId('');
    setPanel('none');
    setMail('');
    setImages({ for: offerId, state: 'loading', items: [] });
    void browserCompute
      .get<{ items: OsImage[] }>(`/v1/offers/${offerId}/images`)
      .then((r) => {
        if (!live) return;
        const items = r.response.ok ? (r.data?.items ?? []) : [];
        setImages({ for: offerId, state: r.response.ok ? 'ok' : 'error', items });
        // coming back from the basket: the operating system chosen there, when this offer still has it
        const want = items.find((i) => i.id === wantImage.current);
        if (want) setImageId(want.id);
        wantImage.current = '';
      })
      .catch(() => live && setImages({ for: offerId, state: 'error', items: [] }));
    return () => {
      live = false;
    };
  }, [offerId]);
  useEffect(() => {
    if (step !== 'review') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  const go = (s: Step) => {
    a.clearProblem();
    a.setNotice(null);
    setStep(s);
  };
  const expired =
    quote !== null &&
    (isQuoteExpired(quote.expiresAt, now) ||
      (a.problem?.code !== undefined && STALE.has(a.problem.code)));

  /** "Add to cart": the exact choice (offer + operating system) goes in the basket; the name, SSH keys and the final quote are asked when it is ordered. */
  function addToBasket() {
    const image = images.items.find((i) => i.id === imageId);
    if (!offer || !image || !p.orgId) {
      setErrs({ image: t(locale, 'm05.web.wiz.image.err') });
      return;
    }
    setErrs({});
    setCarted(
      addServerToCart(p.orgId, offer, { id: image.id, name: image.name }).ok ? 'added' : 'full',
    );
    window.setTimeout(() => setCarted('idle'), 2200);
  }
  function toKeys(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!offer) next.offer = t(locale, 'm05.web.wiz.offer.err');
    if (!isImageId(imageId)) next.image = t(locale, 'm05.web.wiz.image.err');
    if (hestiaOn && mail === '') next.mail = t(locale, 'cloud.cfg.panel.mail.err');
    if (!isInstanceName(name)) next.name = t(locale, 'm05.web.wiz.name.err');
    if (parseDiskGb(disk) === null) next.disk = t(locale, 'm05.web.wiz.disk.err');
    setErrs(next);
    if (Object.keys(next).length === 0) go('keys');
  }
  function requestQuote(e?: FormEvent) {
    e?.preventDefault();
    const { keys, invalid } = parseSshKeys(keysText);
    const next: Record<string, string> = {};
    if (invalid.length)
      next.keys = t(locale, 'm05.web.wiz.keys.err', { lines: invalid.join(', ') });
    else if (keys.length > MAX_SSH_KEYS)
      next.keys = t(locale, 'm05.web.wiz.keys.max', { max: MAX_SSH_KEYS });
    setErrs(next);
    if (Object.keys(next).length || !offer) return;
    const diskGb = parseDiskGb(disk) ?? undefined;
    void a.run(
      () =>
        browserCompute.post<Quote>('/v1/quotes', {
          body: {
            kind: 'compute',
            offerId: offer.offerId,
            spec: {
              imageId: imageId.trim(),
              ...(diskGb ? { diskGb } : {}),
              count: 1,
              ...(hestiaOn
                ? {
                    panel: {
                      kind: 'hestia',
                      template: {
                        id: mail === 'yes' ? 'hestia-web-mail' : 'hestia-web',
                        mail: mail === 'yes',
                      },
                    },
                  }
                : {}),
            },
            term: { period: 'month' },
          },
          idempotencyKey: crypto.randomUUID(),
        }),
      (q) => {
        createKey.current = crypto.randomUUID();
        setQuote(q);
        setNow(Date.now());
        setStep('review');
      },
    );
  }
  function confirm() {
    if (!quote) return;
    const { keys } = parseSshKeys(keysText);
    void a.run(
      () =>
        browserCompute.post<{ instance: { id: string }; operationId: string }>(
          '/v1/compute/instances',
          {
            body: {
              quoteId: quote.id,
              name: name.trim(),
              ...(keys.length ? { sshPublicKeys: keys } : {}),
            },
            idempotencyKey: createKey.current,
          },
        ),
      (r) => {
        // the basket line this order finished is done
        if (p.orgId && p.basketLineId) removeFromCart(p.orgId, p.basketLineId);
        router.push(`/compute/instances/${r.instance.id}`);
      },
    );
  }

  if (p.offers.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.web.wiz.noOffers.title')}
        body={t(locale, 'm05.web.wiz.noOffers.body')}
        action={
          <ButtonLink variant="secondary" href={`/compute/offers`}>
            {t(locale, 'm05.web.tab.offers')}
          </ButtonLink>
        }
      />
    );

  const stepTitle = t(locale, `m05.web.wiz.step.${step}`);
  const res = quote ? residencyOf(quote) : null;
  return (
    <>
      <ol
        aria-label={t(locale, 'm05.web.wiz.steps')}
        className="nz-row nzc-server-steps"
        style={{ listStyle: 'none', padding: 0, margin: 0 }}
      >
        {STEPS.map((s, i) => (
          <li key={s} aria-current={s === step ? 'step' : undefined}>
            <Badge tone={s === step ? 'success' : undefined}>
              {i + 1}. {t(locale, `m05.web.wiz.step.${s}`)}
            </Badge>
          </li>
        ))}
      </ol>
      <section className="nz-card nzc-server-wizard" aria-labelledby="wiz-h">
        <h2 className="nz-h2" id="wiz-h" ref={heading} tabIndex={-1}>
          {stepTitle}
        </h2>

        {step === 'configure' && offer && sel && (
          <form onSubmit={toKeys} noValidate className="nzc-cfg">
            <div className="nzc-cfg-main">
              <section aria-labelledby="cfg-region">
                <h3 className="nzc-cfg-h nzc-cfg-step" id="cfg-region">
                  <i aria-hidden="true">1</i>
                  {t(locale, 'cloud.cfg.region')}
                </h3>
                <div
                  className="nzc-tlds nzc-tlds-grid"
                  role="radiogroup"
                  aria-labelledby="cfg-region"
                >
                  {regionsOf(p.offers).map((r) => (
                    <label key={r.country} className="nzc-tld nzc-opt">
                      <span className="nzc-opt-name">{countryName(locale, r.country)}</span>
                      <input
                        type="radio"
                        name="cfg-region"
                        value={r.country}
                        checked={sel.country === r.country}
                        onChange={() =>
                          setSel(
                            selectionFor(p.offers, {
                              country: r.country,
                              family: sel.family,
                              like: offer,
                            }),
                          )
                        }
                      />
                      <span className="nzc-tld-hint">
                        <span className="nzc-opt-code" dir="ltr">
                          {r.country}
                        </span>{' '}
                        {regionLabel(locale, r.dataRegion)}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="nzc-dsearch-note">{t(locale, 'cloud.cfg.region.note')}</p>
              </section>

              <section aria-labelledby="cfg-line">
                <h3 className="nzc-cfg-h nzc-cfg-step" id="cfg-line">
                  <i aria-hidden="true">2</i>
                  {t(locale, 'cloud.cfg.line')}
                </h3>
                <div
                  className="nzc-tlds nzc-tlds-grid"
                  role="radiogroup"
                  aria-labelledby="cfg-line"
                >
                  {familiesIn(p.offers, sel.country).map((f) => (
                    <label key={f.family} className="nzc-tld nzc-opt">
                      <span className="nzc-opt-name">
                        {tDynamic(
                          locale,
                          `cloud.family.${f.family}`,
                          t(locale, 'cloud.family.core'),
                        )}
                      </span>
                      <input
                        type="radio"
                        name="cfg-line"
                        value={f.family}
                        checked={sel.family === f.family}
                        onChange={() =>
                          setSel(
                            selectionFor(p.offers, {
                              country: sel.country,
                              family: f.family,
                              like: offer,
                            }),
                          )
                        }
                      />
                      <span className="nzc-tld-hint">
                        {tDynamic(locale, `cloud.family.${f.family}.tag`, '')}
                      </span>
                      <span className="nzc-tld-hint nzc-opt-from">
                        {t(locale, 'cloud.cfg.from', {
                          price: moneyText(f.from.price.amount, f.from.price.currency, locale),
                        })}
                      </span>
                    </label>
                  ))}
                </div>
              </section>

              <section aria-labelledby="cfg-size">
                <h3 className="nzc-cfg-h nzc-cfg-step" id="cfg-size">
                  <i aria-hidden="true">3</i>
                  {t(locale, 'cloud.cfg.size')}
                </h3>
                <div
                  className="nzc-tlds nzc-tlds-grid"
                  role="radiogroup"
                  aria-labelledby="cfg-size"
                >
                  {sizesFor(p.offers, sel.country, sel.family).map((o) => (
                    <label key={o.offerId} className="nzc-tld nzc-opt">
                      <span className="nzc-opt-name">
                        {t(locale, 'm05.web.plan.summary', {
                          vcpu: o.plan.vcpu,
                          memory: memoryLabel(o.plan.memoryMb),
                        })}
                      </span>
                      <input
                        type="radio"
                        name="cfg-size"
                        value={o.offerId}
                        checked={offerId === o.offerId}
                        onChange={() => setSel({ ...sel, offerId: o.offerId })}
                      />
                      <span className="nzc-opt-specs">
                        <span>
                          <b dir="ltr">{o.plan.diskGb} GB</b>
                          {t(locale, 'host.row.storage')}
                        </span>
                        {o.plan.bandwidth && (
                          <span>
                            <b dir="ltr">{o.plan.bandwidth}</b>
                            {t(locale, 'host.row.traffic')}
                          </span>
                        )}
                      </span>
                      <span className="nzc-tld-hint nzc-opt-from">
                        <Ltr>{moneyText(o.price.amount, o.price.currency, locale)}</Ltr>{' '}
                        {t(locale, 'm05.web.price.month')}
                      </span>
                    </label>
                  ))}
                </div>
                {errs.offer && (
                  <span className="nz-error-text" role="alert">
                    {errs.offer}
                  </span>
                )}
              </section>

              <section aria-labelledby="cfg-os">
                <h3 className="nzc-cfg-h nzc-cfg-step" id="cfg-os">
                  <i aria-hidden="true">4</i>
                  {t(locale, 'cloud.cfg.os')}
                </h3>
                {images.for === offerId && images.state === 'loading' && (
                  <p className="nz-muted" role="status">
                    {t(locale, 'cloud.cfg.os.loading')}
                  </p>
                )}
                {images.for === offerId && images.state === 'error' && (
                  <p className="nz-error-text" role="alert">
                    {t(locale, 'cloud.cfg.os.error')}
                  </p>
                )}
                {images.for === offerId && images.state === 'ok' && images.items.length === 0 && (
                  <p className="nz-muted">{t(locale, 'cloud.cfg.os.none')}</p>
                )}
                <div className="nzc-tlds nzc-tlds-grid" role="radiogroup" aria-labelledby="cfg-os">
                  {(images.for === offerId ? images.items : []).map((im) => (
                    <label key={im.id} className="nzc-tld nzc-opt">
                      <span className="nzc-opt-name">{im.name}</span>
                      <input
                        type="radio"
                        name="cfg-os"
                        value={im.id}
                        checked={imageId === im.id}
                        onChange={() => {
                          setImageId(im.id);
                          if (!im.hestia) {
                            setPanel('none');
                            setMail('');
                          }
                        }}
                      />
                    </label>
                  ))}
                </div>
                {errs.image && (
                  <span className="nz-error-text" role="alert">
                    {errs.image}
                  </span>
                )}
              </section>

              <section aria-labelledby="cfg-panel">
                <h3 className="nzc-cfg-h nzc-cfg-step" id="cfg-panel">
                  <i aria-hidden="true">5</i>
                  {t(locale, 'cloud.cfg.panel')}
                </h3>
                <div
                  className="nzc-tlds nzc-tlds-grid"
                  role="radiogroup"
                  aria-labelledby="cfg-panel"
                >
                  <label className="nzc-tld nzc-opt">
                    <span className="nzc-opt-name">{t(locale, 'cloud.cfg.panel.none')}</span>
                    <input
                      type="radio"
                      name="cfg-panel"
                      value="none"
                      checked={!hestiaOn}
                      onChange={() => {
                        setPanel('none');
                        setMail('');
                      }}
                    />
                  </label>
                  <label className="nzc-tld nzc-opt" aria-disabled={!hestiaOk}>
                    <span className="nzc-opt-name">{t(locale, 'cloud.cfg.panel.hestia')}</span>
                    <input
                      type="radio"
                      name="cfg-panel"
                      value="hestia"
                      disabled={!hestiaOk}
                      checked={hestiaOn}
                      onChange={() => setPanel('hestia')}
                    />
                    <span className="nzc-tld-hint">
                      {t(
                        locale,
                        hestiaOk ? 'cloud.cfg.panel.hestia.note' : 'cloud.cfg.panel.unavailable',
                      )}
                    </span>
                  </label>
                </div>
                {hestiaOn && (
                  <>
                    <h4 className="nzc-cfg-h" id="cfg-mail">
                      {t(locale, 'cloud.cfg.panel.mail')}
                    </h4>
                    <div
                      className="nzc-tlds nzc-tlds-grid"
                      role="radiogroup"
                      aria-labelledby="cfg-mail"
                    >
                      {(['no', 'yes'] as const).map((v) => (
                        <label key={v} className="nzc-tld nzc-opt">
                          <span className="nzc-opt-name">
                            {t(locale, `cloud.cfg.panel.mail.${v}`)}
                          </span>
                          <input
                            type="radio"
                            name="cfg-mail"
                            value={v}
                            checked={mail === v}
                            onChange={() => setMail(v)}
                          />
                        </label>
                      ))}
                    </div>
                    <p className="nzc-dsearch-note">{t(locale, 'cloud.cfg.panel.mail.help')}</p>
                    {errs.mail && (
                      <span className="nz-error-text" role="alert">
                        {errs.mail}
                      </span>
                    )}
                  </>
                )}
              </section>

              <section className="nzc-cfg-name">
                <Field
                  id="w-name"
                  label={t(locale, 'field.name')}
                  help={t(locale, 'm05.web.wiz.name.help')}
                  error={errs.name}
                >
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      required
                      maxLength={63}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  id="w-disk"
                  label={t(locale, 'm05.web.wiz.disk')}
                  help={t(locale, 'm05.web.wiz.disk.help', { disk: offer.plan.diskGb })}
                  error={errs.disk}
                >
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      inputMode="numeric"
                      value={disk}
                      onChange={(e) => setDisk(e.target.value)}
                    />
                  )}
                </Field>
              </section>
            </div>

            <aside className="nzc-cfg-sum" aria-label={t(locale, 'cloud.cfg.summary')}>
              <img
                className="nzc-server-summary-art"
                src="/images/services/cloud-compact.webp"
                width={120}
                height={80}
                alt=""
                aria-hidden="true"
              />
              <h3 className="nzc-cfg-h">{t(locale, 'cloud.cfg.summary')}</h3>
              <dl>
                <div>
                  <dt>{t(locale, 'cloud.cfg.region')}</dt>
                  <dd>
                    {countryName(locale, offer.country)} · {regionLabel(locale, offer.dataRegion)}
                  </dd>
                </div>
                <div>
                  <dt>{t(locale, 'cloud.cfg.line')}</dt>
                  <dd>
                    {tDynamic(
                      locale,
                      `cloud.family.${familyOf(offer)}`,
                      t(locale, 'cloud.family.core'),
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t(locale, 'cloud.cfg.size')}</dt>
                  <dd>
                    {t(locale, 'cloud.cfg.spec', {
                      vcpu: offer.plan.vcpu,
                      memory: memoryLabel(offer.plan.memoryMb),
                      disk: offer.plan.diskGb,
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t(locale, 'cloud.cfg.os')}</dt>
                  <dd>{images.items.find((i) => i.id === imageId)?.name ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t(locale, 'cloud.cfg.panel')}</dt>
                  <dd>
                    {hestiaOn
                      ? t(locale, mail === 'yes' ? 'vps.panel.tpl.mail' : 'vps.panel.tpl.web')
                      : t(locale, 'cloud.cfg.panel.none')}
                  </dd>
                </div>
              </dl>
              <p className="nzc-cfg-price" aria-live="polite">
                <span className="nz-muted">{t(locale, 'cloud.cfg.monthly')}</span>
                <strong>
                  <Ltr>{moneyText(offer.price.amount, offer.price.currency, locale)}</Ltr>
                </strong>
              </p>
              <p className="nzc-dsearch-note">{t(locale, 'cloud.cfg.vatNote')}</p>
              <Button type="submit">{t(locale, 'action.next')}</Button>
              {p.orgId && !hestiaOn && (
                <Button variant="secondary" onClick={addToBasket}>
                  {carted === 'added' ? (
                    <>
                      <Icon name="check" size={16} /> {t(locale, 'cart.addedBtn')}
                    </>
                  ) : (
                    <>
                      <Icon name="basket" size={16} /> {t(locale, 'cart.add')}
                    </>
                  )}
                </Button>
              )}
              {hestiaOn && p.orgId && (
                <span className="nzc-dsearch-note">{t(locale, 'cloud.cfg.panel.noCart')}</span>
              )}
              {carted === 'full' && (
                <span className="nz-error-text" role="alert">
                  {t(locale, 'cart.full', { max: CART_MAX })}
                </span>
              )}
            </aside>
          </form>
        )}

        {step === 'keys' && (
          <form onSubmit={requestQuote} noValidate>
            <Field
              id="w-keys"
              label={t(locale, 'm05.web.wiz.keys')}
              help={t(locale, 'm05.web.wiz.keys.help')}
              error={errs.keys}
            >
              {(x) => (
                <textarea
                  {...x}
                  className="nz-input"
                  dir="ltr"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  value={keysText}
                  onChange={(e) => setKeysText(e.target.value)}
                />
              )}
            </Field>
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('configure')}>
                {t(locale, 'm05.web.wiz.back')}
              </Button>
              <Button type="submit" disabled={a.busy}>
                {t(locale, 'm05.web.wiz.getQuote')}
              </Button>
            </div>
            {a.problem && (
              <ProblemAlert locale={locale} problem={a.problem}>
                {a.problem.code === 'no_eligible_offer' && (
                  <p>
                    <Button variant="secondary" onClick={() => go('configure')}>
                      {t(locale, 'm05.web.wiz.chooseOther')}
                    </Button>
                  </p>
                )}
              </ProblemAlert>
            )}
          </form>
        )}

        {step === 'review' && quote && res && (
          <>
            <dl style={{ display: 'grid', gap: 'var(--nuzm-space-2)', margin: 0 }}>
              <div className="nz-row">
                <dt className="nz-muted">{t(locale, 'field.name')}</dt>
                <dd style={{ margin: 0 }}>
                  <Ltr>{name.trim()}</Ltr>
                </dd>
              </div>
              {offer && (
                <div className="nz-row">
                  <dt className="nz-muted">{t(locale, 'm05.web.f.plan')}</dt>
                  <dd style={{ margin: 0 }}>
                    {t(locale, 'm05.web.plan.summary', {
                      vcpu: offer.plan.vcpu,
                      memory: memoryLabel(offer.plan.memoryMb),
                    })}{' '}
                    · {regionLabel(locale, offer.dataRegion)}
                  </dd>
                </div>
              )}
              <div className="nz-row">
                <dt className="nz-muted">{t(locale, 'cloud.cfg.os')}</dt>
                <dd style={{ margin: 0 }}>
                  {images.items.find((i) => i.id === imageId)?.name ?? <Ltr>{imageId.trim()}</Ltr>}
                </dd>
              </div>
              {hestiaOn && (
                <div className="nz-row">
                  <dt className="nz-muted">{t(locale, 'cloud.cfg.panel')}</dt>
                  <dd style={{ margin: 0 }}>
                    {t(locale, mail === 'yes' ? 'vps.panel.tpl.mail' : 'vps.panel.tpl.web')}
                  </dd>
                </div>
              )}
              <div className="nz-row">
                <dt className="nz-muted">{t(locale, 'm05.web.wiz.keys')}</dt>
                <dd style={{ margin: 0 }}>
                  {t(locale, 'm05.web.wiz.keys.count', { n: parseSshKeys(keysText).keys.length })}
                </dd>
              </div>
            </dl>

            <Table
              caption={t(locale, 'm05.web.quote.cost')}
              rows={quote.items}
              rowKey={(l) => String(l.position)}
              columns={[
                { key: 'd', header: t(locale, 'bill.f.description'), render: (l) => l.description },
                {
                  key: 'q',
                  header: t(locale, 'bill.f.quantity'),
                  icon: 'data',
                  render: (l) => (
                    <Ltr>
                      {l.quantity} {l.unit}
                    </Ltr>
                  ),
                },
                {
                  key: 'a',
                  header: t(locale, 'bill.f.amount'),
                  icon: 'tag',
                  render: (l) => <Ltr>{moneyText(l.amountMinor, quote.currency, locale)}</Ltr>,
                },
              ]}
            />
            <dl style={{ display: 'grid', gap: 'var(--nuzm-space-2)', margin: 0 }}>
              <div className="nz-row">
                <dt className="nz-muted">{t(locale, 'bill.f.subtotal')}</dt>
                <dd style={{ margin: 0 }}>
                  <Ltr>{moneyText(quote.subtotalMinor, quote.currency, locale)}</Ltr>
                </dd>
              </div>
              <div className="nz-row">
                <dt className="nz-muted">{t(locale, 'bill.f.tax')}</dt>
                <dd style={{ margin: 0 }}>
                  <Ltr>{moneyText(quote.taxEstimate.taxMinor, quote.currency, locale)}</Ltr>{' '}
                  {quote.taxEstimate.status === 'provisional' && (
                    <Badge tone="warn">{t(locale, 'm05.web.quote.provisional')}</Badge>
                  )}
                </dd>
              </div>
              <div className="nz-row">
                <dt>
                  <strong>{t(locale, 'bill.f.total')}</strong>
                </dt>
                <dd style={{ margin: 0 }}>
                  <strong>
                    <Ltr>{moneyText(quote.totalMinor, quote.currency, locale)}</Ltr>
                  </strong>{' '}
                  <span className="nz-muted">{t(locale, 'm05.web.price.month')}</span>
                </dd>
              </div>
            </dl>
            {quote.taxEstimate.reviewRequired && (
              <Banner tone="warn">{t(locale, 'm05.web.quote.taxReview')}</Banner>
            )}

            <section aria-labelledby="wiz-res">
              <h3 className="nz-h2" id="wiz-res">
                {t(locale, 'm05.web.quote.residency')}
              </h3>
              <p>
                {res.verdict === 'allowed' &&
                  t(locale, 'm05.web.quote.res.allowed', {
                    region: res.dataRegion ? regionLabel(locale, res.dataRegion) : '—',
                    version: res.policyVersion ?? '—',
                  })}
                {res.verdict === 'denied' && t(locale, 'm05.web.err.residency_denied')}
                {res.verdict === 'not_evaluated' && t(locale, 'm05.web.quote.res.pending')}
                {res.verdict === 'other' &&
                  t(locale, 'm05.web.quote.res.other', { decision: res.raw })}
              </p>
            </section>

            {quote.requiresApproval && (
              <Banner tone="warn">
                {t(locale, 'm05.web.quote.needsApproval')}{' '}
                <a
                  href={`/billing/approvals${queryString({
                    quoteId: quote.id,
                    amountMinor: quote.totalMinor,
                  })}`}
                >
                  {t(locale, 'm05.web.err.approvalLink')}
                </a>
              </Banner>
            )}
            <p className={expired ? 'nz-error-text' : 'nz-muted'} role="status">
              {expired
                ? t(locale, 'm05.web.quote.expired')
                : t(locale, 'm05.web.quote.validFor', {
                    time: mmss(secondsLeft(quote.expiresAt, now)),
                    until: formatDateTime(quote.expiresAt, locale),
                  })}
            </p>
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('keys')} disabled={a.busy}>
                {t(locale, 'm05.web.wiz.back')}
              </Button>
              {expired ? (
                <Button onClick={() => requestQuote()} disabled={a.busy}>
                  {t(locale, 'm05.web.quote.renew')}
                </Button>
              ) : (
                <Button onClick={confirm} disabled={a.busy}>
                  {t(locale, 'm05.web.wiz.confirm')}
                </Button>
              )}
            </div>
            {a.problem && <ProblemAlert locale={locale} problem={a.problem} />}
          </>
        )}
        {!a.problem && <NoticeText notice={a.notice} />}
        {a.panel}
      </section>
    </>
  );
}
