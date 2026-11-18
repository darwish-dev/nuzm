import type { ReactNode } from 'react';
import { formatDateTime, formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Card, Ltr, Table } from '@nuzm/ui';
import { trimDec } from '../lib/billing';
import type { Tone } from '../lib/data';

/** Server-safe presentational pieces shared by the managed data and email screens. No state, no I/O. */

export function StatusBadge({
  locale,
  prefix,
  value,
  tone,
}: {
  locale: Locale;
  prefix: string;
  value: string;
  tone?: Tone;
}) {
  return <Badge tone={tone}>{tDynamic(locale, `${prefix}.${value}`, value)}</Badge>;
}

/** "An operation is in progress" with the operation id (the operation list shows its state). */
export function OperationNote({
  locale,
  operationId,
  banner,
}: {
  locale: Locale;
  operationId: string | null | undefined;
  banner?: boolean;
}) {
  if (!operationId) return null;
  const body = (
    <>
      {t(locale, 'm8.c.opInProgress')}{' '}
      <a href={`/${locale}/operations`}>
        {t(locale, 'm8.c.opId')} <Ltr>{operationId}</Ltr>
      </a>
    </>
  );
  return banner ? <Banner tone="warn">{body}</Banner> : <p className="nz-muted">{body}</p>;
}

/** A labelled value in a definition list. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export interface QuoteView {
  id: string;
  kind: string;
  currency: string;
  expiresAt: string;
  items: {
    position: number;
    description: string;
    quantity: string;
    unit: string;
    unitPriceMinor: string | null;
    amountMinor: string;
  }[];
  subtotalMinor: string;
  taxEstimate: { taxMinor: string };
  totalMinor: string;
  requiresApproval: boolean;
}

/**
 * The quote the user is about to confirm: lines, totals, the residency note and the approval requirement. The quote's own `residency` field stays
 * `not_evaluated`; database and storage quotes are refused outright (403) when the placement is not allowed, so an issued quote of those kinds has passed.
 */
export function QuoteSummary({ locale, quote }: { locale: Locale; quote: QuoteView }) {
  const checked = quote.kind === 'database' || quote.kind === 'storage';
  return (
    <Card aria-label={t(locale, 'm8.q.title')}>
      <h2 className="nz-h2">{t(locale, 'm8.q.title')}</h2>
      <Table
        caption={t(locale, 'm8.q.title')}
        rows={quote.items}
        rowKey={(i) => String(i.position)}
        columns={[
          { key: 'd', header: t(locale, 'bill.f.item'), render: (i) => i.description },
          {
            key: 'q',
            header: t(locale, 'bill.f.quantity'),
            render: (i) => <Ltr>{`${trimDec(i.quantity)} ${i.unit}`}</Ltr>,
          },
          {
            key: 'a',
            header: t(locale, 'bill.f.amount'),
            render: (i) => <Ltr>{formatMinor(i.amountMinor, quote.currency, locale)}</Ltr>,
          },
        ]}
      />
      <dl>
        <Fact label={t(locale, 'bill.f.subtotal')}>
          <Ltr>{formatMinor(quote.subtotalMinor, quote.currency, locale)}</Ltr>
        </Fact>
        <Fact label={t(locale, 'bill.f.tax')}>
          <Ltr>{formatMinor(quote.taxEstimate.taxMinor, quote.currency, locale)}</Ltr>
        </Fact>
        <Fact label={t(locale, 'bill.f.total')}>
          <strong>
            <Ltr>{formatMinor(quote.totalMinor, quote.currency, locale)}</Ltr>
          </strong>
        </Fact>
      </dl>
      <p className="nz-muted">{t(locale, 'bill.quote.provisional')}</p>
      <p>
        <Badge tone={checked ? 'success' : undefined}>
          {checked ? t(locale, 'm8.q.residencyOk') : t(locale, 'm8.q.residencyLater')}
        </Badge>{' '}
        <span className="nz-muted">
          {t(locale, 'm8.q.expires', { time: formatDateTime(quote.expiresAt, locale) })}
        </span>
      </p>
      {quote.requiresApproval && (
        <Banner tone="warn">
          {t(locale, 'm8.q.approval')}{' '}
          <a href={`/${locale}/billing/quotes/${quote.id}`}>{t(locale, 'm8.q.approvalLink')}</a>
        </Banner>
      )}
    </Card>
  );
}

/** Section links of the database screens. */
export function SectionTabs({
  locale,
  label,
  current,
  tabs,
}: {
  locale: Locale;
  label: string;
  current: string;
  tabs: { key: string; href: string; label: string }[];
}) {
  void locale;
  return (
    <nav aria-label={label} className="nz-row nzc-subtabs">
      {tabs.map((x) => (
        <a
          key={x.key}
          className="nz-btn"
          data-variant={x.key === current ? 'primary' : 'secondary'}
          href={x.href}
          aria-current={x.key === current ? 'page' : undefined}
        >
          {x.label}
        </a>
      ))}
    </nav>
  );
}

export function DatabaseTabs({
  locale,
  id,
  current,
}: {
  locale: Locale;
  id: string;
  current: 'overview' | 'backups' | 'settings';
}) {
  return (
    <SectionTabs
      locale={locale}
      label={t(locale, 'm8.dbd.nav')}
      current={current}
      tabs={[
        {
          key: 'overview',
          href: `/${locale}/databases/${id}`,
          label: t(locale, 'm8.dbd.tab.overview'),
        },
        {
          key: 'backups',
          href: `/${locale}/databases/${id}/backups`,
          label: t(locale, 'm8.dbd.tab.backups'),
        },
        {
          key: 'settings',
          href: `/${locale}/databases/${id}/settings`,
          label: t(locale, 'm8.dbd.tab.settings'),
        },
      ]}
    />
  );
}

export type EmailSection =
  'domains' | 'mailboxes' | 'senders' | 'templates' | 'messages' | 'suppressions';
export function EmailTabs({ locale, current }: { locale: Locale; current: EmailSection }) {
  const keys: EmailSection[] = [
    'domains',
    'mailboxes',
    'senders',
    'templates',
    'messages',
    'suppressions',
  ];
  return (
    <SectionTabs
      locale={locale}
      label={t(locale, 'm8.em.nav')}
      current={current}
      tabs={keys.map((k) => ({
        key: k,
        href: `/${locale}/email/${k}`,
        label: t(locale, `m8.em.tab.${k}`),
      }))}
    />
  );
}
