import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, ButtonLink, Card, EmptyState, Field, Input, Ltr, Select } from '@nuzm/ui';
import { PLATFORMS, designOf, safeHex, type Template, type filtersOf } from '../lib/templates';

/** Presentational pieces of the customer template screens (S-K7). Server-safe: no state. Nothing here ever shows a file path, a key or a file's contents: the API has none to give. */

const platformLabel = (locale: Locale, p: string) => tDynamic(locale, `kn.platform.${p}`, p);

export function TemplateFilters({
  locale,
  f,
}: {
  locale: Locale;
  f: ReturnType<typeof filtersOf>;
}) {
  const active = Boolean(f.q || f.platform || f.framework);
  return (
    <form
      className="kn-filters"
      method="get"
      role="search"
      aria-label={t(locale, 'tpl.filter.label')}
    >
      <div className="kn-filter-grid">
        <Field id="tpl-q" label={t(locale, 'tpl.filter.q')}>
          {(a) => <Input {...a} name="q" defaultValue={f.q} maxLength={200} />}
        </Field>
        <Field id="tpl-platform" label={t(locale, 'tpl.filter.platform')}>
          {(a) => (
            <Select {...a} name="platform" defaultValue={f.platform}>
              <option value="">{t(locale, 'kd.all')}</option>
              {PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {platformLabel(locale, p)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="tpl-framework" label={t(locale, 'tpl.filter.framework')}>
          {(a) => (
            <Input {...a} name="framework" dir="ltr" defaultValue={f.framework} maxLength={40} />
          )}
        </Field>
        <div className="kni-toolbar">
          <button className="nz-btn" data-variant="primary" type="submit">
            {t(locale, 'tpl.filter.apply')}
          </button>
          {active && (
            <ButtonLink variant="secondary" href={`/${locale}/builder/templates`}>
              {t(locale, 'tpl.filter.clear')}
            </ButtonLink>
          )}
        </div>
      </div>
    </form>
  );
}

export function TemplateCards({
  locale,
  items,
  next,
  filtered,
}: {
  locale: Locale;
  items: Template[];
  next: string | null;
  filtered: boolean;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        title={t(locale, 'tpl.empty.title')}
        body={t(locale, filtered ? 'tpl.empty.filtered' : 'tpl.empty.body')}
      />
    );
  return (
    <>
      <ul className="bl-pgrid" aria-label={t(locale, 'tpl.list.label')}>
        {items.map((x) => (
          <li key={x.id}>
            <article className="bl-pcard" aria-labelledby={`tpl-c-${x.id}`} data-testid="tpl-card">
              <div className="bl-pbody">
                <div className="bl-ptop">
                  <h2 id={`tpl-c-${x.id}`}>
                    <a href={`/${locale}/builder/templates/${x.id}`}>{x.name}</a>
                  </h2>
                  <Badge tone={x.ownership === 'OWN' ? 'success' : undefined}>
                    {t(locale, x.ownership === 'OWN' ? 'tpl.own' : 'tpl.platformTemplate')}
                  </Badge>
                </div>
                {x.description && <p className="nz-muted">{x.description.slice(0, 220)}</p>}
                <dl className="bl-pmeta">
                  {x.platform && (
                    <div>
                      <dt>{t(locale, 'tpl.filter.platform')}</dt>
                      <dd>{platformLabel(locale, x.platform)}</dd>
                    </div>
                  )}
                  {(x.frameworks ?? []).length > 0 && (
                    <div>
                      <dt>{t(locale, 'tpl.card.frameworks')}</dt>
                      <dd>
                        <Ltr>{(x.frameworks ?? []).slice(0, 4).join(', ')}</Ltr>
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>{t(locale, 'tpl.card.reuse')}</dt>
                    <dd>{usagesText(locale, x)}</dd>
                  </div>
                  <div>
                    <dt>{t(locale, 'tpl.card.license')}</dt>
                    <dd>
                      <Ltr>{x.license?.spdx ?? t(locale, 'tpl.license.unknown')}</Ltr>
                    </dd>
                  </div>
                </dl>
                <ButtonLink variant="secondary" href={`/${locale}/builder/templates/${x.id}`}>
                  {t(locale, 'tpl.card.view')}
                </ButtonLink>
              </div>
            </article>
          </li>
        ))}
      </ul>
      {next && (
        <p>
          <ButtonLink variant="secondary" href={next} rel="next">
            {t(locale, 'tpl.next')}
          </ButtonLink>
        </p>
      )}
    </>
  );
}

const usagesText = (locale: Locale, x: Template): string =>
  (x.reuse?.usages ?? []).map((u) => tDynamic(locale, `kr.usage.${u}`, u)).join('، ') || '—';

export function TemplateDetail({ locale, x }: { locale: Locale; x: Template }) {
  const d = designOf(x);
  const traits = d
    ? [
        d.traits.darkMode ? t(locale, 'tpl.trait.darkMode') : null,
        d.traits.rtl ? t(locale, 'kd.trait.rtl') : null,
        d.traits.tailwind ? t(locale, 'kd.trait.tailwind') : null,
      ].filter(Boolean)
    : [];
  return (
    <div className="knd">
      <div className="knd-head">
        <div>
          <h1 className="nz-h1">{x.name}</h1>
          <p className="nz-muted">
            <Badge tone={x.ownership === 'OWN' ? 'success' : undefined}>
              {t(locale, x.ownership === 'OWN' ? 'tpl.own' : 'tpl.platformTemplate')}
            </Badge>{' '}
            {t(locale, 'tpl.detail.version', { n: x.versionSeq ?? 1 })}
            {x.semver && (
              <>
                {' · '}
                <Ltr>{x.semver}</Ltr>
              </>
            )}
          </p>
        </div>
        <ButtonLink variant="secondary" href={`/${locale}/builder/templates`}>
          {t(locale, 'tpl.detail.back')}
        </ButtonLink>
      </div>
      <div className="knd-grid">
        <Card aria-labelledby="tpl-about-h">
          <h2 className="nz-h2" id="tpl-about-h">
            {t(locale, 'tpl.detail.about')}
          </h2>
          {x.description && <p>{x.description}</p>}
          <dl>
            {x.platform && (
              <>
                <dt>{t(locale, 'tpl.filter.platform')}</dt>
                <dd>{platformLabel(locale, x.platform)}</dd>
              </>
            )}
            {(x.frameworks ?? []).length > 0 && (
              <>
                <dt>{t(locale, 'tpl.card.frameworks')}</dt>
                <dd>
                  <Ltr>{(x.frameworks ?? []).join(', ')}</Ltr>
                </dd>
              </>
            )}
            {(x.languages ?? []).length > 0 && (
              <>
                <dt>{t(locale, 'tpl.detail.languages')}</dt>
                <dd>
                  <Ltr>{(x.languages ?? []).join(', ')}</Ltr>
                </dd>
              </>
            )}
            {x.category && (
              <>
                <dt>{t(locale, 'tpl.detail.category')}</dt>
                <dd>{x.category}</dd>
              </>
            )}
            {(x.tags ?? []).length > 0 && (
              <>
                <dt>{t(locale, 'tpl.detail.tags')}</dt>
                <dd>{(x.tags ?? []).join('، ')}</dd>
              </>
            )}
            <dt>{t(locale, 'tpl.card.reuse')}</dt>
            <dd>{usagesText(locale, x)}</dd>
            <dt>{t(locale, 'tpl.card.license')}</dt>
            <dd>
              <Ltr>{x.license?.spdx ?? t(locale, 'tpl.license.unknown')}</Ltr>
            </dd>
            <dt>{t(locale, 'tpl.card.components')}</dt>
            <dd>
              <Ltr>{String(x.componentCount ?? 0)}</Ltr>
            </dd>
          </dl>
        </Card>
        <Card aria-labelledby="tpl-cap-h">
          <h2 className="nz-h2" id="tpl-cap-h">
            {t(locale, 'tpl.detail.capabilities')}
          </h2>
          {(x.capabilities ?? []).length === 0 ? (
            <p className="nz-muted">{t(locale, 'tpl.detail.capabilities.none')}</p>
          ) : (
            <ul className="kni-list">
              {(x.capabilities ?? []).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </Card>
        <Card aria-labelledby="tpl-design-h">
          <h2 className="nz-h2" id="tpl-design-h">
            {t(locale, 'tpl.detail.design')}
          </h2>
          {!d ? (
            <p className="nz-muted">{t(locale, 'tpl.detail.design.none')}</p>
          ) : (
            <>
              <dl>
                {d.modes.length > 0 && (
                  <>
                    <dt>{t(locale, 'tpl.detail.modes')}</dt>
                    <dd>{d.modes.map((m) => tDynamic(locale, `kd.mode.${m}`, m)).join('، ')}</dd>
                  </>
                )}
                {traits.length > 0 && (
                  <>
                    <dt>{t(locale, 'tpl.detail.traits')}</dt>
                    <dd>{traits.join('، ')}</dd>
                  </>
                )}
                {d.families.length > 0 && (
                  <>
                    <dt>{t(locale, 'tpl.detail.fonts')}</dt>
                    <dd>
                      <Ltr>{d.families.join(', ')}</Ltr>
                    </dd>
                  </>
                )}
                {d.baseUnit !== null && (
                  <>
                    <dt>{t(locale, 'tpl.detail.unit')}</dt>
                    <dd>
                      <Ltr>{`${d.baseUnit}px`}</Ltr>
                    </dd>
                  </>
                )}
              </dl>
              {d.roles.length > 0 && (
                <>
                  <h3 className="nz-h3">{t(locale, 'tpl.detail.colors')}</h3>
                  <ul className="kd-swatches">
                    {d.roles.map((r) => (
                      <li className="kd-swatch" key={r.role}>
                        <span
                          className="kd-chip"
                          aria-hidden="true"
                          style={{ background: safeHex(r.hex) ?? undefined }}
                        />
                        <span>
                          {tDynamic(locale, `kd.role.${r.role}`, r.role)} <Ltr>{r.hex}</Ltr>
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
