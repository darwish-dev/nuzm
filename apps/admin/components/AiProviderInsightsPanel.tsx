'use client';
import { useState, type ReactNode } from 'react';
import type { Locale } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Field,
  ForbiddenState,
  Ltr,
  Select,
  Skeleton,
  Table,
} from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  USAGE_GROUPS,
  USAGE_RANGES,
  breakerTone,
  dateText,
  epochText,
  healthTone,
  moneyText,
  msText,
  percentText,
  shortId,
  ti,
  toResult,
  usageRange,
  type Discovery,
  type HealthItem,
  type ProviderOption,
  type RateVersion,
  type RegistryItem,
  type Result,
  type UsageReport,
} from '../lib/ai-insights';
import { Note, useStaffAction } from './BillingAdminPanels';

/**
 * Provider insights (S-AG4 Phase 2): health, capability registry, usage report, rate-card history and model discovery. Everything is read-only except the discovery button, which
 * is a live, read-only request to the vendor that the API refuses unless the owner opened the live gate. Each section has its own loading, empty, error and forbidden state, so one
 * failing call never blanks the others. Text: `lib/ai-insights.ts` (Arabic and English).
 */
type Section<T> =
  { state: 'loading' } | { state: 'ok'; data: T } | { state: 'forbidden' } | { state: 'error' };
const sectionOf = <T,>(r: Result<T>): Section<T> =>
  r.ok
    ? { state: 'ok', data: r.data }
    : r.status === 403
      ? { state: 'forbidden' }
      : { state: 'error' };

function Frame({
  id,
  title,
  help,
  children,
}: {
  id: string;
  title: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={id} style={{ marginBlockStart: 24 }}>
      <h2 className="nz-h2">{title}</h2>
      {help && <p className="nz-muted">{help}</p>}
      {children}
    </section>
  );
}
function Gate<T>({
  locale,
  s,
  children,
}: {
  locale: Locale;
  s: Section<T>;
  children: (d: T) => ReactNode;
}) {
  return (
    <div data-state={s.state}>
      {s.state === 'loading' ? (
        <Skeleton lines={3} label={ti(locale, 'ins.loading')} />
      ) : s.state === 'forbidden' ? (
        <ForbiddenState
          title={ti(locale, 'ins.forbidden.title')}
          body={ti(locale, 'ins.forbidden.body')}
        />
      ) : s.state === 'error' ? (
        <ErrorState title={ti(locale, 'ins.err.title')} body={ti(locale, 'ins.err.body')} />
      ) : (
        children(s.data)
      )}
    </div>
  );
}

function Health({ locale, items }: { locale: Locale; items: HealthItem[] }) {
  if (items.length === 0)
    return (
      <EmptyState
        title={ti(locale, 'ins.health.empty')}
        body={ti(locale, 'ins.health.emptyBody')}
      />
    );
  return (
    <Table
      caption={ti(locale, 'ins.health.title')}
      rows={items}
      rowKey={(r) => r.key}
      columns={[
        { key: 'k', header: ti(locale, 'ins.health.key'), render: (r) => <Ltr>{r.key}</Ltr> },
        {
          key: 's',
          header: ti(locale, 'ins.health.status'),
          render: (r) => (
            <Badge tone={healthTone(r.status)}>{ti(locale, `ins.status.${r.status}`)}</Badge>
          ),
        },
        {
          key: 'n',
          header: ti(locale, 'ins.health.samples'),
          render: (r) => <Ltr>{String(r.samples)}</Ltr>,
        },
        {
          key: 'p',
          header: ti(locale, 'ins.health.success'),
          render: (r) => <Ltr>{percentText(r.successPerMille)}</Ltr>,
        },
        {
          key: 'l',
          header: ti(locale, 'ins.health.latency'),
          render: (r) => <Ltr>{`${msText(r.p50LatencyMs)} / ${msText(r.p95LatencyMs)}`}</Ltr>,
        },
        {
          key: 'e',
          header: ti(locale, 'ins.health.lastError'),
          render: (r) =>
            r.lastErrorCode ? <Ltr>{`${r.lastErrorCode} · ${epochText(r.lastErrorAt)}`}</Ltr> : '—',
        },
        {
          key: 'b',
          header: ti(locale, 'ins.health.circuit'),
          render: (r) => (
            <Badge tone={breakerTone(r.breaker)}>{ti(locale, `ins.breaker.${r.breaker}`)}</Badge>
          ),
        },
      ]}
    />
  );
}

function Registry({ locale, items }: { locale: Locale; items: RegistryItem[] }) {
  if (items.length === 0)
    return (
      <EmptyState title={ti(locale, 'ins.reg.empty')} body={ti(locale, 'ins.reg.emptyBody')} />
    );
  return (
    <Table
      caption={ti(locale, 'ins.reg.title')}
      rows={items}
      rowKey={(r) => `${r.providerCode}/${r.modelId}`}
      columns={[
        {
          key: 'p',
          header: ti(locale, 'ins.reg.provider'),
          render: (r) => (
            <>
              <Ltr>{r.providerCode}</Ltr>
              {!r.providerEnabled && <p className="nz-muted">{ti(locale, 'ins.reg.disabled')}</p>}
            </>
          ),
        },
        { key: 'm', header: ti(locale, 'ins.reg.model'), render: (r) => <Ltr>{r.modelId}</Ltr> },
        {
          key: 'c',
          header: ti(locale, 'ins.reg.limits'),
          render: (r) => <Ltr>{`${r.contextTokens} / ${r.maxOutputTokens}`}</Ltr>,
        },
        {
          key: 'r',
          header: ti(locale, 'ins.reg.priced'),
          render: (r) =>
            r.priced ? (
              <Badge tone="success">{ti(locale, 'ins.reg.yes')}</Badge>
            ) : (
              <Badge tone="warn">{ti(locale, 'ins.reg.noPrice')}</Badge>
            ),
        },
        {
          key: 'k',
          header: ti(locale, 'ins.reg.caps'),
          render: (r) => (
            <ul>
              {r.capabilities.map((c) => (
                <li key={c.capability}>
                  <Ltr>{c.capability}</Ltr>{' '}
                  <Badge tone={c.effective ? 'success' : c.declared ? 'warn' : undefined}>
                    {c.effective
                      ? ti(locale, 'ins.reg.effective')
                      : c.declared
                        ? ti(locale, 'ins.reg.pending')
                        : ti(locale, 'ins.basis.not_declared')}
                  </Badge>
                  <p className="nz-muted">{ti(locale, `ins.basis.${c.basis}`)}</p>
                </li>
              ))}
            </ul>
          ),
        },
      ]}
    />
  );
}

function Usage({ locale }: { locale: Locale }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [group, setGroup] = useState<(typeof USAGE_GROUPS)[number]>('provider');
  const [s, setS] = useState<Section<UsageReport> | null>(null);
  async function load() {
    setS({ state: 'loading' });
    const r = await browserApi().GET('/v1/admin/ai/usage', {
      params: { query: { ...usageRange(days, new Date()), groupBy: group } },
    });
    setS(sectionOf(toResult<UsageReport>(r as never)));
  }
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}
      >
        <Field id="ins-use-range" label={ti(locale, 'ins.use.range')}>
          {(x) => (
            <Select
              {...x}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}
            >
              {USAGE_RANGES.map((d) => (
                <option key={d} value={d}>
                  {ti(locale, 'ins.use.days', { n: d })}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="ins-use-group" label={ti(locale, 'ins.use.group')}>
          {(x) => (
            <Select
              {...x}
              value={group}
              onChange={(e) => setGroup(e.target.value as (typeof USAGE_GROUPS)[number])}
            >
              {USAGE_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {ti(locale, `ins.use.group.${g}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" data-testid="ins-usage-show" disabled={s?.state === 'loading'}>
          {ti(locale, 'ins.use.show')}
        </Button>
      </form>
      {s && (
        <Gate locale={locale} s={s}>
          {(d) => (
            <>
              {d.truncated && <Banner tone="warn">{ti(locale, 'ins.use.truncated')}</Banner>}
              {d.rows.length === 0 ? (
                <EmptyState
                  title={ti(locale, 'ins.use.empty')}
                  body={ti(locale, 'ins.use.emptyBody')}
                />
              ) : (
                <Table
                  caption={ti(locale, 'ins.use.title')}
                  rows={d.rows}
                  rowKey={(r) => `${r.providerCode}|${r.modelRef ?? ''}|${r.day ?? ''}`}
                  columns={[
                    {
                      key: 'p',
                      header: ti(locale, 'ins.use.col.provider'),
                      render: (r) => <Ltr>{r.providerCode}</Ltr>,
                    },
                    ...(d.groupBy === 'provider'
                      ? []
                      : [
                          {
                            key: 'm',
                            header: ti(locale, 'ins.use.col.model'),
                            render: (r: UsageReport['rows'][number]) =>
                              r.modelRef ? <Ltr>{r.modelRef}</Ltr> : '—',
                          },
                        ]),
                    ...(d.groupBy === 'day'
                      ? [
                          {
                            key: 'd',
                            header: ti(locale, 'ins.use.col.day'),
                            render: (r: UsageReport['rows'][number]) => <Ltr>{r.day ?? '—'}</Ltr>,
                          },
                        ]
                      : []),
                    {
                      key: 'c',
                      header: ti(locale, 'ins.use.col.calls'),
                      render: (r) => <Ltr>{`${r.calls} (${r.okCalls} / ${r.errorCalls})`}</Ltr>,
                    },
                    {
                      key: 'e',
                      header: ti(locale, 'ins.use.col.estimated'),
                      render: (r) => <Ltr>{String(r.estimatedCalls)}</Ltr>,
                    },
                    {
                      key: 't',
                      header: ti(locale, 'ins.use.col.tokens'),
                      render: (r) => <Ltr>{`${r.tokensIn} / ${r.tokensOut}`}</Ltr>,
                    },
                    {
                      key: 'cr',
                      header: ti(locale, 'ins.use.col.credits'),
                      render: (r) => <Ltr>{r.credits}</Ltr>,
                    },
                    {
                      key: 'm$',
                      header: ti(locale, 'ins.use.col.cost'),
                      render: (r) =>
                        r.costCurrency === 'MIXED' ? (
                          <span data-mixed="true">{ti(locale, 'ins.use.mixed')}</span>
                        ) : (
                          <Ltr>{moneyText(r.costMinor, r.costCurrency)}</Ltr>
                        ),
                    },
                    {
                      key: 'l',
                      header: ti(locale, 'ins.use.col.latency'),
                      render: (r) => (
                        <Ltr>{`${msText(r.p50LatencyMs)} / ${msText(r.p95LatencyMs)}`}</Ltr>
                      ),
                    },
                  ]}
                />
              )}
            </>
          )}
        </Gate>
      )}
    </>
  );
}

function RateHistory({ locale, providers }: { locale: Locale; providers: ProviderOption[] }) {
  const [id, setId] = useState('');
  const [s, setS] = useState<Section<{ items: RateVersion[] }> | null>(null);
  async function load() {
    if (!id) return;
    setS({ state: 'loading' });
    const r = await browserApi().GET('/v1/admin/ai/model-providers/{id}/rate-card-versions', {
      params: { path: { id } },
    });
    setS(sectionOf(toResult<{ items: RateVersion[] }>(r as never)));
  }
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
        style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}
      >
        <Field id="ins-rc-provider" label={ti(locale, 'ins.rc.provider')}>
          {(x) => (
            <Select {...x} value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">{ti(locale, 'ins.rc.choose')}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button
          type="submit"
          data-testid="ins-ratecard-show"
          disabled={!id || s?.state === 'loading'}
        >
          {ti(locale, 'ins.rc.show')}
        </Button>
      </form>
      {s && (
        <Gate locale={locale} s={s}>
          {(d) =>
            d.items.length === 0 ? (
              <EmptyState title={ti(locale, 'ins.rc.empty')} body={ti(locale, 'ins.rc.help')} />
            ) : (
              <Table
                caption={ti(locale, 'ins.rc.title')}
                rows={d.items}
                rowKey={(r) => r.id}
                columns={[
                  {
                    key: 'v',
                    header: ti(locale, 'ins.rc.version'),
                    render: (r) => <Ltr>{r.version}</Ltr>,
                  },
                  {
                    key: 'r',
                    header: ti(locale, 'ins.rc.recorded'),
                    render: (r) => <Ltr>{dateText(r.recordedAt)}</Ltr>,
                  },
                  {
                    key: 'b',
                    header: ti(locale, 'ins.rc.by'),
                    render: (r) => <Ltr>{shortId(r.recordedBy)}</Ltr>,
                  },
                  {
                    key: 'm',
                    header: ti(locale, 'ins.rc.models'),
                    render: (r) => (
                      <ul>
                        {Object.entries(r.models).map(([m, v]) => (
                          <li key={m}>
                            <Ltr>{`${m}: ${v.creditsPerMillionInput} / ${v.creditsPerMillionOutput}`}</Ltr>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                  {
                    key: 'c',
                    header: ti(locale, 'ins.rc.changes'),
                    render: (r) =>
                      r.changes.length === 0 ? (
                        ti(locale, 'ins.rc.none')
                      ) : (
                        <ul>
                          {r.changes.map((c) => (
                            <li key={`${c.modelId}-${c.change}`}>
                              {ti(locale, `ins.rc.${c.change}`)}: <Ltr>{c.modelId}</Ltr>
                            </li>
                          ))}
                        </ul>
                      ),
                  },
                ]}
              />
            )
          }
        </Gate>
      )}
    </>
  );
}

function DiscoveryCard({
  locale,
  providers,
  mfaFactorId,
}: {
  locale: Locale;
  providers: ProviderOption[];
  mfaFactorId: string | null;
}) {
  const a = useStaffAction(locale, mfaFactorId);
  const [id, setId] = useState('');
  const [res, setRes] = useState<Discovery | null>(null);
  function run() {
    if (!id) return;
    setRes(null);
    void a.run(
      () =>
        browserApi().POST('/v1/admin/ai/model-providers/{id}/model-discovery', {
          params: { path: { id } },
        }) as never,
      (data) => setRes(data as Discovery),
      { 422: ti(locale, 'ins.disc.refused'), 503: ti(locale, 'ins.disc.failed') },
    );
  }
  const list = (items: string[]) =>
    items.length === 0 ? ti(locale, 'ins.disc.none') : items.map((m) => <Ltr key={m}>{m} </Ltr>);
  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <Field id="ins-disc-provider" label={ti(locale, 'ins.rc.provider')}>
          {(x) => (
            <Select {...x} value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">{ti(locale, 'ins.rc.choose')}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName} ({p.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button data-testid="ins-discovery-run" disabled={!id || a.busy} onClick={run}>
          {ti(locale, 'ins.disc.run')}
        </Button>
      </div>
      <div data-testid="ins-discovery-note">
        <Note n={a.notice} />
      </div>
      {a.panel}
      {res && (
        <div role="status">
          <p>
            <Badge tone="warn">{ti(locale, 'ins.disc.live')}</Badge>{' '}
            {ti(locale, 'ins.disc.done', { when: dateText(res.checkedAt) })}
          </p>
          <p>
            <strong>{ti(locale, 'ins.disc.confirmed')}:</strong> {list(res.confirmed)}
          </p>
          <p>
            <strong>{ti(locale, 'ins.disc.unlisted')}:</strong> {list(res.unlistedByVendor)}
          </p>
          <p>
            <strong>{ti(locale, 'ins.disc.notDeclared')}:</strong>{' '}
            {list(res.notDeclared.map((m) => m.modelId))}
          </p>
        </div>
      )}
    </>
  );
}

export function AiProviderInsightsPanel(p: {
  locale: Locale;
  health: Result<{ items: HealthItem[] }>;
  registry: Result<{ items: RegistryItem[] }>;
  providers: ProviderOption[];
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const { locale } = p;
  const health = sectionOf(p.health);
  const registry = sectionOf(p.registry);
  return (
    <div data-testid="ai-insights">
      <h2 className="nz-h2" style={{ marginBlockStart: 32 }}>
        {ti(locale, 'ins.title')}
      </h2>
      <p className="nz-muted">{ti(locale, 'ins.help')}</p>
      <Frame
        id="ins-health"
        title={ti(locale, 'ins.health.title')}
        help={ti(locale, 'ins.health.scope')}
      >
        <Gate locale={locale} s={health}>
          {(d) => <Health locale={locale} items={d.items} />}
        </Gate>
      </Frame>
      <Frame
        id="ins-registry"
        title={ti(locale, 'ins.reg.title')}
        help={ti(locale, 'ins.reg.help')}
      >
        <Gate locale={locale} s={registry}>
          {(d) => <Registry locale={locale} items={d.items} />}
        </Gate>
      </Frame>
      <Frame id="ins-usage" title={ti(locale, 'ins.use.title')} help={ti(locale, 'ins.use.help')}>
        <Usage locale={locale} />
      </Frame>
      <Frame id="ins-ratecard" title={ti(locale, 'ins.rc.title')} help={ti(locale, 'ins.rc.help')}>
        <RateHistory locale={locale} providers={p.providers} />
      </Frame>
      {p.canManage && (
        <Frame
          id="ins-discovery"
          title={ti(locale, 'ins.disc.title')}
          help={ti(locale, 'ins.disc.help')}
        >
          <DiscoveryCard locale={locale} providers={p.providers} mfaFactorId={p.mfaFactorId} />
        </Frame>
      )}
    </div>
  );
}
