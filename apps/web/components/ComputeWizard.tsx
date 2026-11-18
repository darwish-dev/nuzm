'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, ButtonLink, EmptyState, Field, Input, Ltr, Table } from '@nuzm/ui';
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

type Step = 'offer' | 'image' | 'keys' | 'review';
const STEPS: Step[] = ['offer', 'image', 'keys', 'review'];
/** Problems after which the quote cannot be used any more: the user must get a fresh one. */
const STALE = new Set(['quote_expired', 'quote_consumed', 'price_changed']);

const mmss = (s: number): string =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/**
 * UI-M05-02: offer → image → SSH keys → quote review (cost, tax estimate, residency result) → confirm.
 * The quote is immutable and short-lived (15 min): the review shows a countdown and, once it ran out (or the API says quote_expired /
 * quote_consumed / price_changed), blocks confirming and offers a fresh quote. The Idempotency-Key of the create call belongs to the
 * quote, so a double click or a retry after an uncertain answer can never create a second instance.
 */
export function ComputeWizard(p: {
  locale: Locale;
  offers: Offer[];
  initialOfferId?: string;
  mfaFactorId: string | null;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useComputeAction(locale, p.mfaFactorId);
  const [step, setStep] = useState<Step>('offer');
  const [offerId, setOfferId] = useState(
    p.offers.some((o) => o.offerId === p.initialOfferId) ? (p.initialOfferId as string) : '',
  );
  const [imageId, setImageId] = useState('');
  const [name, setName] = useState('');
  const [disk, setDisk] = useState('');
  const [keysText, setKeysText] = useState('');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<Quote | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const createKey = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);
  const offer = p.offers.find((o) => o.offerId === offerId);

  useEffect(() => heading.current?.focus(), [step]);
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

  function toImage() {
    if (!offer) return setErrs({ offer: t(locale, 'm05.web.wiz.offer.err') });
    setErrs({});
    go('image');
  }
  function toKeys(e: FormEvent) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!isImageId(imageId)) next.image = t(locale, 'm05.web.wiz.image.err');
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
            spec: { imageId: imageId.trim(), ...(diskGb ? { diskGb } : {}), count: 1 },
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
      (r) => router.push(`/${locale}/compute/instances/${r.instance.id}`),
    );
  }

  if (p.offers.length === 0)
    return (
      <EmptyState
        title={t(locale, 'm05.web.wiz.noOffers.title')}
        body={t(locale, 'm05.web.wiz.noOffers.body')}
        action={
          <ButtonLink variant="secondary" href={`/${locale}/compute/offers`}>
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
        className="nz-row"
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
      <section className="nz-card" aria-labelledby="wiz-h">
        <h2 className="nz-h2" id="wiz-h" ref={heading} tabIndex={-1}>
          {stepTitle}
        </h2>

        {step === 'offer' && (
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="nz-sr">{stepTitle}</legend>
            {p.offers.map((o) => {
              const label = t(locale, 'm05.web.offers.choose', {
                vcpu: o.plan.vcpu,
                memory: memoryLabel(o.plan.memoryMb),
                region: regionLabel(locale, o.dataRegion),
              });
              return (
                <div key={o.offerId} className="nz-row">
                  <input
                    type="radio"
                    id={`offer-${o.offerId}`}
                    name="offer"
                    value={o.offerId}
                    checked={offerId === o.offerId}
                    onChange={() => setOfferId(o.offerId)}
                  />
                  <label htmlFor={`offer-${o.offerId}`}>
                    {label} · {t(locale, 'm05.web.plan.disk', { disk: o.plan.diskGb })} ·{' '}
                    <Ltr>{moneyText(o.price.amount, o.price.currency, locale)}</Ltr>{' '}
                    {t(locale, 'm05.web.price.month')}
                  </label>
                </div>
              );
            })}
            {errs.offer && (
              <span className="nz-error-text" role="alert">
                {errs.offer}
              </span>
            )}
            <p>
              <Button onClick={toImage}>{t(locale, 'action.next')}</Button>
            </p>
          </fieldset>
        )}

        {step === 'image' && (
          <form onSubmit={toKeys} noValidate>
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
              id="w-image"
              label={t(locale, 'm05.web.wiz.image')}
              help={t(locale, 'm05.web.wiz.image.help')}
              error={errs.image}
            >
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  required
                  value={imageId}
                  onChange={(e) => setImageId(e.target.value)}
                />
              )}
            </Field>
            <Field
              id="w-disk"
              label={t(locale, 'm05.web.wiz.disk')}
              help={t(locale, 'm05.web.wiz.disk.help', { disk: offer?.plan.diskGb ?? 0 })}
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
            <div className="nz-row">
              <Button variant="secondary" onClick={() => go('offer')}>
                {t(locale, 'm05.web.wiz.back')}
              </Button>
              <Button type="submit">{t(locale, 'action.next')}</Button>
            </div>
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
              <Button variant="secondary" onClick={() => go('image')}>
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
                    <Button variant="secondary" onClick={() => go('offer')}>
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
                <dt className="nz-muted">{t(locale, 'm05.web.wiz.image')}</dt>
                <dd style={{ margin: 0 }}>
                  <Ltr>{imageId.trim()}</Ltr>
                </dd>
              </div>
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
                  href={`/${locale}/billing/approvals${queryString({
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
