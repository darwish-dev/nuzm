'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, ButtonLink, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { newKey } from '../lib/data';
import {
  LISTING_TYPES,
  SEMVER,
  artifactPrefix,
  moneyText,
  toMinor,
  type InstallationDto,
  type ListingDto,
  type PurchaseDto,
  type VersionDto,
} from '../lib/m11';
import { Note } from './DataUi';
import { IssueList, useM11Call } from './M11Ui';

const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" rows={3} {...p} />
);

interface QuoteShape {
  id: string;
  currency: string;
  expiresAt: string;
  subtotalMinor: string;
  totalMinor: string;
  taxEstimate: { taxMinor: string; rateBps: number };
  requiresApproval: boolean;
}

/* ------------------------------------------------------------------ UI-M11-07: buy */

/**
 * Buy a listing: a `marketplace` quote (price + provisional VAT estimate) first, then the purchase from that quote. The purchase creates an invoice through billing; the entitlement
 * is `pending` until the invoice is PAID, so the result links to the invoice and its "pay" screen (the existing billing payments UI) instead of pretending the licence is active.
 */
export function BuyPanel({
  locale,
  listing,
  version,
  mfaFactorId,
}: {
  locale: Locale;
  listing: ListingDto;
  version: VersionDto;
  mfaFactorId: string | null;
}) {
  const call = useM11Call(locale, mfaFactorId);
  const [quote, setQuote] = useState<QuoteShape | null>(null);
  const [purchase, setPurchase] = useState<PurchaseDto | null>(null);
  const [idem, setIdem] = useState(newKey());
  const money = (v: string, c: string) => <Ltr>{moneyText(v, c, locale)}</Ltr>;

  const getQuote = () =>
    void call.run(
      () =>
        browserApi().POST('/v1/quotes', {
          params: { header: { 'Idempotency-Key': newKey() } },
          body: {
            kind: 'marketplace',
            items: [{ listingId: listing.id, versionId: version.id }],
            currency: listing.price.currency,
          },
        }),
      (q) => setQuote(q as unknown as QuoteShape),
    );
  const confirm = (ev: FormEvent) => {
    ev.preventDefault();
    if (!quote) return;
    void call.run(
      () =>
        browserApi().POST('/v1/marketplace/purchases', {
          params: { header: { 'Idempotency-Key': idem } },
          body: { listingId: listing.id, versionId: version.id, quoteId: quote.id },
        }),
      (p) => {
        setPurchase(p as unknown as PurchaseDto);
        setIdem(newKey());
      },
      (p) => {
        if (p.code === 'quote_expired' || p.code === 'price_changed') setQuote(null);
        setIdem(newKey());
      },
    );
  };

  if (purchase)
    return (
      <section className="nz-card" aria-label={t(locale, 'm11.buy.result')} role="status">
        <h2 className="nz-h2">{t(locale, 'm11.buy.result')}</h2>
        <p className="nz-row">
          <Badge tone={purchase.status === 'paid' ? 'success' : 'warn'}>
            {tDynamic(locale, `m11.pur.status.${purchase.status}`, purchase.status)}
          </Badge>
          <Badge tone={purchase.entitlementStatus === 'active' ? 'success' : 'warn'}>
            {tDynamic(
              locale,
              `m11.pur.ent.${purchase.entitlementStatus}`,
              purchase.entitlementStatus,
            )}
          </Badge>
        </p>
        <p>{t(locale, purchase.status === 'paid' ? 'm11.buy.paid' : 'm11.buy.pending')}</p>
        <div className="nz-row">
          {purchase.invoiceId && purchase.status !== 'paid' && (
            <ButtonLink href={`/billing/invoices/${purchase.invoiceId}`}>
              {t(locale, 'm11.buy.payInvoice')}
            </ButtonLink>
          )}
          {purchase.invoiceId && (
            <a href={`/billing/invoices/${purchase.invoiceId}`}>
              {t(locale, 'm11.buy.invoice')} <Ltr>{purchase.invoiceId.slice(0, 8)}</Ltr>
            </a>
          )}
          <a href={`/marketplace/purchases`}>{t(locale, 'm11.buy.toPurchases')}</a>
        </div>
      </section>
    );

  return (
    <form
      onSubmit={confirm}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.buy.title')}
      style={{ maxInlineSize: 560 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.buy.title')}</h2>
      {!quote ? (
        <>
          <p>
            {t(locale, 'm11.buy.price')}: {money(listing.price.amount, listing.price.currency)}
          </p>
          <Button disabled={call.busy} onClick={getQuote}>
            {t(locale, 'm11.buy.getQuote')}
          </Button>
        </>
      ) : (
        <>
          <dl>
            <dt>{t(locale, 'm11.buy.subtotal')}</dt>
            <dd>{money(quote.subtotalMinor, quote.currency)}</dd>
            <dt>{t(locale, 'm11.buy.vat', { rate: quote.taxEstimate.rateBps / 100 })}</dt>
            <dd>{money(quote.taxEstimate.taxMinor, quote.currency)}</dd>
            <dt>{t(locale, 'm11.buy.total')}</dt>
            <dd>
              <strong>{money(quote.totalMinor, quote.currency)}</strong>
            </dd>
          </dl>
          <p className="nz-muted">{t(locale, 'm11.buy.vatNote')}</p>
          <p className="nz-muted">
            {t(locale, 'm11.buy.expires', { time: formatDateTime(quote.expiresAt, locale) })}
          </p>
          {quote.requiresApproval && <Banner tone="warn">{t(locale, 'm11.buy.approval')}</Banner>}
          <div className="nz-row">
            <Button type="submit" disabled={call.busy}>
              {t(locale, 'm11.buy.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setQuote(null)}>
              {t(locale, 'action.cancel')}
            </Button>
          </div>
        </>
      )}
      <Note n={call.notice} />
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M11-08: install */

/**
 * Install a purchased listing as a COPY in the organization. A workflow template creates a workflow; a website or app template needs a workspace and the builder, and the API answers
 * 422 `unsupported_capability` where that is not wired: said plainly, with the API's own reason.
 */
export function InstallForm({
  locale,
  listing,
  versions,
  workspaces,
  mfaFactorId,
}: {
  locale: Locale;
  listing: { id: string; type: string | null };
  versions: VersionDto[];
  workspaces: { id: string; name: string }[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [version, setVersion] = useState(versions[0]?.id ?? '');
  const [workspace, setWorkspace] = useState(workspaces[0]?.id ?? '');
  const [done, setDone] = useState<InstallationDto | null>(null);
  const [unsupported, setUnsupported] = useState<string | undefined>();
  const needsWorkspace = listing.type !== 'workflow-template';
  if (versions.length === 0)
    return <span className="nz-muted">{t(locale, 'm11.inst.noVersion')}</span>;
  return (
    <form
      noValidate
      aria-label={t(locale, 'm11.inst.title')}
      onSubmit={(e) => {
        e.preventDefault();
        setUnsupported(undefined);
        void call.run(
          () =>
            browserApi().POST('/v1/marketplace/installations', {
              params: { header: { 'Idempotency-Key': newKey() } },
              body: {
                listingVersionId: version,
                ...(needsWorkspace && workspace ? { workspaceId: workspace } : {}),
              },
            }),
          (r) => {
            setDone(r as unknown as InstallationDto);
            router.refresh();
          },
          (p) => {
            if (p.code === 'unsupported_capability') {
              setUnsupported(p.detail ?? '');
              return true;
            }
          },
        );
      }}
    >
      <Field id={`iv-${listing.id}`} label={t(locale, 'm11.inst.version')}>
        {(a) => (
          <Select {...a} value={version} onChange={(e) => setVersion(e.target.value)}>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.version}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {needsWorkspace && (
        <Field
          id={`iw-${listing.id}`}
          label={t(locale, 'm11.inst.workspace')}
          help={workspaces.length === 0 ? t(locale, 'm11.inst.noWorkspace') : undefined}
        >
          {(a) => (
            <Select {...a} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Button type="submit" disabled={call.busy || (needsWorkspace && !workspace)}>
        {t(locale, 'm11.inst.action')}
      </Button>
      <Note n={call.notice} />
      {unsupported !== undefined && (
        <div role="alert">
          <p className="nz-error-text">{t(locale, 'm11.inst.unsupported')}</p>
          {unsupported && (
            <p className="nz-muted">
              <bdi dir="auto">{unsupported}</bdi>
            </p>
          )}
        </div>
      )}
      {done && (
        <p role="status">
          {t(locale, 'm11.inst.done', {
            status: tDynamic(locale, `m11.inst.status.${done.status}`, done.status),
          })}{' '}
          {done.targetType === 'workflow' && done.targetId && (
            <a href={`/automation/workflows/${done.targetId}/edit`}>
              {t(locale, 'm11.inst.openWorkflow')}
            </a>
          )}
        </p>
      )}
      {call.panel}
    </form>
  );
}

/* ------------------------------------------------------------------ UI-M11-09: publisher */

/** The publisher account is not verified yet (403 `publisher_not_verified`): verification is a person-run step at the platform; nothing here can speed it up. */
export function VerificationPending({ locale }: { locale: Locale }) {
  return (
    <div role="alert" className="nz-state">
      <h2>{t(locale, 'm11.pub.pending.title')}</h2>
      <p>{t(locale, 'm11.pub.pending.body')}</p>
    </div>
  );
}

export function CreateListingForm({
  locale,
  orgId,
  mfaFactorId,
}: {
  locale: Locale;
  orgId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [type, setType] = useState<string>(LISTING_TYPES[0]);
  const [titleAr, setTitleAr] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [descAr, setDescAr] = useState('');
  const [descEn, setDescEn] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState('SAR');
  const [licence, setLicence] = useState('single_org');
  const [seats, setSeats] = useState('1');
  const [artifact, setArtifact] = useState(artifactPrefix(orgId));
  const [sbom, setSbom] = useState('');
  const [version, setVersion] = useState('1.0.0');
  const [changelog, setChangelog] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  const [idem, setIdem] = useState(newKey());

  function submit(ev: FormEvent) {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!titleAr.trim()) e.titleAr = t(locale, 'm11.pub.err.title');
    if (!titleEn.trim()) e.titleEn = t(locale, 'm11.pub.err.title');
    const minor = toMinor(price);
    if (minor === null) e.price = t(locale, 'm11.pub.err.price');
    const n = Number(seats);
    if (!Number.isInteger(n) || n < 1 || n > 1000 || (licence === 'single_org' && n !== 1))
      e.seats = t(locale, 'm11.pub.err.seats');
    if (artifact.trim() !== '' && artifact.trim() !== artifactPrefix(orgId)) {
      if (!artifact.trim().startsWith(artifactPrefix(orgId)))
        e.artifact = t(locale, 'm11.pub.err.artifact', { prefix: artifactPrefix(orgId) });
      if (!SEMVER.test(version.trim())) e.version = t(locale, 'm11.pub.err.version');
    }
    setErr(e);
    if (Object.keys(e).length > 0) return;
    const hasArtifact = artifact.trim() !== '' && artifact.trim() !== artifactPrefix(orgId);
    void call.run(
      () =>
        browserApi().POST('/v1/marketplace/listings', {
          params: { header: { 'Idempotency-Key': idem } },
          body: {
            type,
            title: { ar: titleAr.trim(), en: titleEn.trim() },
            description: {
              ...(descAr.trim() ? { ar: descAr.trim() } : {}),
              ...(descEn.trim() ? { en: descEn.trim() } : {}),
            },
            price: { amount: minor!, currency },
            licence,
            seats: n,
            ...(hasArtifact
              ? {
                  artifactRef: artifact.trim(),
                  version: version.trim(),
                  ...(sbom.trim() ? { sbomRef: sbom.trim() } : {}),
                  ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
                }
              : {}),
          },
        }),
      () => {
        setIdem(newKey());
        setTitleAr('');
        setTitleEn('');
        call.setNotice({ tone: 'ok', text: t(locale, 'm11.pub.created') });
        router.refresh();
      },
      () => setIdem(newKey()),
    );
  }
  if (call.last?.code === 'publisher_not_verified') return <VerificationPending locale={locale} />;
  return (
    <form
      onSubmit={submit}
      noValidate
      className="nz-card"
      aria-label={t(locale, 'm11.pub.new')}
      style={{ maxInlineSize: 680 }}
    >
      <h2 className="nz-h2">{t(locale, 'm11.pub.new')}</h2>
      <Field id="pl-type" label={t(locale, 'field.type')}>
        {(a) => (
          <Select {...a} value={type} onChange={(e) => setType(e.target.value)}>
            {LISTING_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(locale, `m11.mkt.type.${x}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="nz-row">
        <Field id="pl-title-ar" label={t(locale, 'm11.pub.titleAr')} error={err.titleAr}>
          {(a) => (
            <Input
              {...a}
              dir="rtl"
              lang="ar"
              maxLength={160}
              value={titleAr}
              onChange={(e) => setTitleAr(e.target.value)}
            />
          )}
        </Field>
        <Field id="pl-title-en" label={t(locale, 'm11.pub.titleEn')} error={err.titleEn}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              lang="en"
              maxLength={160}
              value={titleEn}
              onChange={(e) => setTitleEn(e.target.value)}
            />
          )}
        </Field>
      </div>
      <Field id="pl-desc-ar" label={t(locale, 'm11.pub.descAr')}>
        {(a) => (
          <TextArea
            {...a}
            dir="rtl"
            lang="ar"
            value={descAr}
            onChange={(e) => setDescAr(e.target.value)}
          />
        )}
      </Field>
      <Field id="pl-desc-en" label={t(locale, 'm11.pub.descEn')}>
        {(a) => (
          <TextArea
            {...a}
            dir="ltr"
            lang="en"
            value={descEn}
            onChange={(e) => setDescEn(e.target.value)}
          />
        )}
      </Field>
      <div className="nz-row">
        <Field
          id="pl-price"
          label={t(locale, 'm11.pub.price')}
          help={t(locale, 'm11.pub.priceHelp')}
          error={err.price}
        >
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          )}
        </Field>
        <Field id="pl-currency" label={t(locale, 'm11.pub.currency')}>
          {(a) => (
            <Select {...a} value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {['SAR', 'USD', 'EUR'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="nz-row">
        <Field id="pl-licence" label={t(locale, 'm11.pub.licence')}>
          {(a) => (
            <Select {...a} value={licence} onChange={(e) => setLicence(e.target.value)}>
              <option value="single_org">{t(locale, 'm11.mkt.licence.single_org')}</option>
              <option value="multi_seat">{t(locale, 'm11.mkt.licence.multi_seat')}</option>
            </Select>
          )}
        </Field>
        <Field id="pl-seats" label={t(locale, 'm11.pub.seats')} error={err.seats}>
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              inputMode="numeric"
              value={seats}
              onChange={(e) => setSeats(e.target.value)}
            />
          )}
        </Field>
      </div>
      <p className="nz-muted">{t(locale, 'm11.pub.artifactNote')}</p>
      <Field
        id="pl-artifact"
        label={t(locale, 'm11.pub.artifact')}
        help={t(locale, 'm11.pub.artifactHelp')}
        error={err.artifact}
      >
        {(a) => (
          <Input {...a} dir="ltr" value={artifact} onChange={(e) => setArtifact(e.target.value)} />
        )}
      </Field>
      <div className="nz-row">
        <Field id="pl-version" label={t(locale, 'm11.pub.version')} error={err.version}>
          {(a) => (
            <Input {...a} dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} />
          )}
        </Field>
        <Field id="pl-sbom" label={t(locale, 'm11.pub.sbom')}>
          {(a) => <Input {...a} dir="ltr" value={sbom} onChange={(e) => setSbom(e.target.value)} />}
        </Field>
      </div>
      <Field id="pl-changelog" label={t(locale, 'm11.pub.changelog')}>
        {(a) => (
          <TextArea {...a} value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        )}
      </Field>
      <Button type="submit" disabled={call.busy}>
        {t(locale, 'action.create')}
      </Button>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}

/** Submit a new (immutable) version of a listing: hashed and scanned at once, then it waits for a person to approve it. */
export function SubmitVersionForm({
  locale,
  listing,
  orgId,
  mfaFactorId,
}: {
  locale: Locale;
  listing: Pick<ListingDto, 'id'>;
  orgId: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [artifact, setArtifact] = useState(artifactPrefix(orgId));
  const [sbom, setSbom] = useState('');
  const [changelog, setChangelog] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});
  const [idem, setIdem] = useState(newKey());
  if (call.last?.code === 'publisher_not_verified') return <VerificationPending locale={locale} />;
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t(locale, 'm11.pub.submitVersion')}
      </Button>
    );
  return (
    <form
      noValidate
      aria-label={t(locale, 'm11.pub.submitVersion')}
      className="nz-card"
      onSubmit={(ev) => {
        ev.preventDefault();
        const e: Record<string, string> = {};
        if (!SEMVER.test(version.trim())) e.version = t(locale, 'm11.pub.err.version');
        if (
          !artifact.trim().startsWith(artifactPrefix(orgId)) ||
          artifact.trim() === artifactPrefix(orgId)
        )
          e.artifact = t(locale, 'm11.pub.err.artifact', { prefix: artifactPrefix(orgId) });
        setErr(e);
        if (Object.keys(e).length > 0) return;
        void call.run(
          () =>
            browserApi().POST('/v1/marketplace/listings/{id}/versions', {
              params: { path: { id: listing.id }, header: { 'Idempotency-Key': idem } },
              body: {
                version: version.trim(),
                artifactRef: artifact.trim(),
                ...(sbom.trim() ? { sbomRef: sbom.trim() } : {}),
                ...(changelog.trim() ? { changelog: changelog.trim() } : {}),
              },
            }),
          () => {
            setIdem(newKey());
            setOpen(false);
            router.refresh();
          },
          () => setIdem(newKey()),
        );
      }}
    >
      <Field
        id={`sv-version-${listing.id}`}
        label={t(locale, 'm11.pub.version')}
        error={err.version}
      >
        {(a) => (
          <Input {...a} dir="ltr" value={version} onChange={(e) => setVersion(e.target.value)} />
        )}
      </Field>
      <Field
        id={`sv-artifact-${listing.id}`}
        label={t(locale, 'm11.pub.artifact')}
        help={t(locale, 'm11.pub.artifactHelp')}
        error={err.artifact}
      >
        {(a) => (
          <Input {...a} dir="ltr" value={artifact} onChange={(e) => setArtifact(e.target.value)} />
        )}
      </Field>
      <Field id={`sv-sbom-${listing.id}`} label={t(locale, 'm11.pub.sbom')}>
        {(a) => <Input {...a} dir="ltr" value={sbom} onChange={(e) => setSbom(e.target.value)} />}
      </Field>
      <Field id={`sv-changelog-${listing.id}`} label={t(locale, 'm11.pub.changelog')}>
        {(a) => (
          <TextArea {...a} value={changelog} onChange={(e) => setChangelog(e.target.value)} />
        )}
      </Field>
      <div className="nz-row">
        <Button type="submit" disabled={call.busy}>
          {t(locale, 'm11.pub.submitAction')}
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t(locale, 'action.cancel')}
        </Button>
      </div>
      <Note n={call.notice} />
      <IssueList locale={locale} issues={call.issues} />
      {call.panel}
    </form>
  );
}
