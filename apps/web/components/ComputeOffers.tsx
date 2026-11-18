import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, ButtonLink, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import {
  GEO_GROUPS,
  memoryLabel,
  moneyText,
  queryString,
  type Offer,
  type OfferFilterErrors,
  type OfferFilters,
} from '../lib/compute';
import { CapabilityList } from './ComputeBits';

export const regionLabel = (locale: Locale, group: string): string =>
  tDynamic(locale, `m05.web.region.${group}`, group);

/** UI-M05-01: verified offers with country / region-group / spec filters. A plain GET form: it works without client JS. */
export function OffersPanel(p: {
  locale: Locale;
  offers: Offer[];
  nextCursor: string | null;
  filters: OfferFilters;
  errors: OfferFilterErrors;
  canCreate: boolean;
}) {
  const { locale, filters } = p;
  const filtered = Object.keys(filters).length > 0;
  const next = p.nextCursor ? queryString({ ...filters, cursor: p.nextCursor }) : null;
  return (
    <>
      <form
        method="get"
        className="nz-card"
        aria-label={t(locale, 'm05.web.offers.filters')}
        noValidate
      >
        <h2 className="nz-h2">{t(locale, 'm05.web.offers.filters')}</h2>
        <div className="nz-row" style={{ alignItems: 'flex-start' }}>
          <Field
            id="f-country"
            label={t(locale, 'field.country')}
            help={t(locale, 'm05.web.offers.country.help')}
            error={p.errors.country ? t(locale, 'm05.web.offers.country.err') : undefined}
          >
            {(x) => (
              <Input
                {...x}
                name="country"
                dir="ltr"
                maxLength={2}
                autoComplete="off"
                defaultValue={filters.country ?? ''}
              />
            )}
          </Field>
          <Field
            id="f-group"
            label={t(locale, 'm05.web.offers.geoGroup')}
            error={p.errors.geoGroup ? t(locale, 'm05.web.offers.geoGroup.err') : undefined}
          >
            {(x) => (
              <Select {...x} name="geoGroup" defaultValue={filters.geoGroup ?? ''}>
                <option value="">{t(locale, 'm05.web.offers.any')}</option>
                {GEO_GROUPS.map((g) => (
                  <option key={g} value={g}>
                    {regionLabel(locale, g)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            id="f-vcpu"
            label={t(locale, 'm05.web.offers.minVcpu')}
            error={p.errors.minVcpu ? t(locale, 'm05.web.offers.num.err') : undefined}
          >
            {(x) => (
              <Input
                {...x}
                name="minVcpu"
                dir="ltr"
                inputMode="numeric"
                defaultValue={filters.minVcpu ?? ''}
              />
            )}
          </Field>
          <Field
            id="f-mem"
            label={t(locale, 'm05.web.offers.minMemory')}
            error={p.errors.minMemoryMb ? t(locale, 'm05.web.offers.num.err') : undefined}
          >
            {(x) => (
              <Input
                {...x}
                name="minMemoryMb"
                dir="ltr"
                inputMode="numeric"
                defaultValue={filters.minMemoryMb ?? ''}
              />
            )}
          </Field>
        </div>
        <div className="nz-row">
          <Button type="submit">{t(locale, 'action.search')}</Button>
          {filtered && (
            <ButtonLink variant="secondary" href={`/${locale}/compute/offers`}>
              {t(locale, 'm05.web.offers.reset')}
            </ButtonLink>
          )}
        </div>
      </form>
      {p.offers.length === 0 ? (
        <EmptyState
          title={t(locale, 'm05.web.offers.empty.title')}
          body={t(locale, filtered ? 'm05.web.offers.empty.filtered' : 'm05.web.offers.empty.body')}
        />
      ) : (
        <Table
          caption={t(locale, 'm05.web.offers.title')}
          rows={p.offers}
          rowKey={(o) => o.offerId}
          columns={[
            {
              key: 'plan',
              header: t(locale, 'm05.web.f.plan'),
              icon: 'tag',
              render: (o) => (
                <>
                  <strong>
                    {t(locale, 'm05.web.plan.summary', {
                      vcpu: o.plan.vcpu,
                      memory: memoryLabel(o.plan.memoryMb),
                    })}
                  </strong>
                  <br />
                  <span className="nz-muted">
                    {t(locale, 'm05.web.plan.disk', { disk: o.plan.diskGb })}
                  </span>
                </>
              ),
            },
            {
              key: 'region',
              header: t(locale, 'field.region'),
              icon: 'pin',
              render: (o) => (
                <>
                  <Badge>{regionLabel(locale, o.dataRegion)}</Badge> <Ltr>{o.country}</Ltr>
                </>
              ),
            },
            {
              key: 'price',
              header: t(locale, 'm05.web.f.price'),
              icon: 'tag',
              render: (o) => (
                <>
                  <Ltr>{moneyText(o.price.amount, o.price.currency, locale)}</Ltr>{' '}
                  <span className="nz-muted">{t(locale, 'm05.web.price.month')}</span>
                </>
              ),
            },
            {
              key: 'caps',
              header: t(locale, 'm05.web.f.capabilities'),
              render: (o) => <CapabilityList locale={locale} caps={o.capabilities} />,
            },
            {
              key: 'verified',
              header: t(locale, 'm05.web.f.verified'),
              render: (o) => (o.verifiedAt ? formatDateTime(o.verifiedAt, locale) : '—'),
            },
            {
              key: 'act',
              header: t(locale, 'field.action'),
              icon: 'code',
              render: (o) =>
                p.canCreate ? (
                  <ButtonLink
                    variant="secondary"
                    href={`/${locale}/compute/instances/new${queryString({ offerId: o.offerId })}`}
                  >
                    {t(locale, 'm05.web.offers.use')}
                    <span className="nz-sr">
                      {' '}
                      {t(locale, 'm05.web.offers.choose', {
                        vcpu: o.plan.vcpu,
                        memory: memoryLabel(o.plan.memoryMb),
                        region: regionLabel(locale, o.dataRegion),
                      })}
                    </span>
                  </ButtonLink>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
      {next && (
        <p>
          <ButtonLink variant="secondary" href={`/${locale}/compute/offers${next}`}>
            {t(locale, 'm05.web.page.next')}
          </ButtonLink>
        </p>
      )}
    </>
  );
}
