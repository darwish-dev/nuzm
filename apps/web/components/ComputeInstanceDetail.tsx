'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Banner, Button, ButtonLink, Field, Ltr, Select } from '@nuzm/ui';
import { browserCompute } from '../lib/compute-client';
import { useComputeAction } from '../lib/compute-actions';
import {
  actionAllowed,
  isTransient,
  isUncertain,
  memoryLabel,
  moneyText,
  supportsMetrics,
  supportsSnapshot,
  visibleActions,
  type ActionType,
  type Instance,
  type OperationView,
  type Offer,
} from '../lib/compute';
import { CapabilityList, InstanceBadges, OperationTimeline, ProblemAlert } from './ComputeBits';
import { regionLabel } from './ComputeOffers';
import { NoticeText } from './Feedback';

/** Re-reads the server data while the instance is provisioning or deleting, so the page follows the operation without a manual reload. */
function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [active, router]);
  return null;
}

/** Instance sub-navigation: metrics and snapshots are linked only when the instance supports them. */
export function InstanceNav({
  locale,
  instance,
  current,
}: {
  locale: Locale;
  instance: Pick<Instance, 'id' | 'capabilities'>;
  current: 'overview' | 'metrics' | 'snapshots';
}) {
  const base = `/${locale}/compute/instances/${instance.id}`;
  const links = [
    { key: 'overview', href: base, show: true },
    { key: 'metrics', href: `${base}/metrics`, show: supportsMetrics(instance.capabilities) },
    { key: 'snapshots', href: `${base}/snapshots`, show: supportsSnapshot(instance.capabilities) },
  ] as const;
  return (
    <nav aria-label={t(locale, 'm05.web.detail.nav')} className="nz-row">
      {links
        .filter((l) => l.show || l.key === current)
        .map((l) => (
          <a
            key={l.key}
            className="nz-btn"
            data-variant={l.key === current ? 'primary' : 'secondary'}
            href={l.href}
            aria-current={l.key === current ? 'page' : undefined}
          >
            {t(locale, `m05.web.detail.tab.${l.key}`)}
          </a>
        ))}
    </nav>
  );
}

/** UI-M05-04: overview, capability-based action menu, delete, operation timeline, uncertain-state banner. */
export function InstanceDetail(p: {
  locale: Locale;
  instance: Instance;
  operation: OperationView | null;
  /** eligible offers, for resize */
  offers: Offer[];
  canAct: boolean;
  canDelete: boolean;
  mfaFactorId: string | null;
  /** ETag of the instance as the API sent it; used for If-Match (falls back to the quoted version number) */
  etag?: string | null;
}) {
  const { locale, instance: i } = p;
  const router = useRouter();
  const a = useComputeAction(locale, p.mfaFactorId);
  const [resizeTo, setResizeTo] = useState('');
  const [confirming, setConfirming] = useState(false);
  const uncertain = isUncertain(i.status, p.operation?.state, i.driftState);
  const actions = visibleActions(i.capabilities);
  const sizes = p.offers.filter((o) => o.dataRegion === i.dataRegion && o.country === i.country);
  const gone = i.status === 'deleted' || i.status === 'deleting';

  const act = (type: ActionType, params?: Record<string, unknown>) =>
    void a.run(
      () =>
        browserCompute.post<{ operationId: string }>(`/v1/compute/instances/${i.id}/actions`, {
          body: params ? { type, params } : { type },
          idempotencyKey: crypto.randomUUID(),
        }),
      () => {
        a.setNotice({
          tone: 'ok',
          text: t(locale, 'm05.web.act.accepted', { action: t(locale, `m05.web.act.${type}`) }),
        });
        router.refresh();
      },
    );

  const remove = () =>
    void a.run(
      () =>
        browserCompute.del<{ operationId: string }>(`/v1/compute/instances/${i.id}`, {
          // the instance version is the ETag: a concurrent change answers 412 instead of deleting a changed resource
          ifMatch: p.etag || `"${i.version}"`,
          idempotencyKey: crypto.randomUUID(),
        }),
      () => {
        setConfirming(false);
        a.setNotice({ tone: 'ok', text: t(locale, 'm05.web.delete.accepted') });
        router.refresh();
      },
    );

  return (
    <>
      <AutoRefresh active={isTransient(i.status)} />
      {uncertain && (
        <Banner tone="warn">
          <strong>{t(locale, 'm05.web.uncertain.title')}</strong>{' '}
          {t(locale, 'm05.web.uncertain.body')}
        </Banner>
      )}
      <section className="nz-card" aria-labelledby="inst-overview">
        <h2 className="nz-h2" id="inst-overview">
          {t(locale, 'm05.web.detail.overview')}
        </h2>
        <dl style={{ display: 'grid', gap: 'var(--nuzm-space-2)', margin: 0 }}>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'field.name')}</dt>
            <dd style={{ margin: 0 }}>
              <Ltr>{i.name}</Ltr>
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'field.status')}</dt>
            <dd style={{ margin: 0 }}>
              <InstanceBadges locale={locale} status={i.status} driftState={i.driftState} />
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'm05.web.f.plan')}</dt>
            <dd style={{ margin: 0 }}>
              {t(locale, 'm05.web.plan.summary', {
                vcpu: i.plan.vcpu,
                memory: memoryLabel(i.plan.memoryMb),
              })}
              {' · '}
              {t(locale, 'm05.web.plan.disk', { disk: i.plan.diskGb })}
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'field.region')}</dt>
            <dd style={{ margin: 0 }}>
              {regionLabel(locale, i.dataRegion)} <Ltr>{i.country}</Ltr>
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'm05.web.f.ips')}</dt>
            <dd style={{ margin: 0 }}>
              {i.publicIps.length ? <Ltr>{i.publicIps.join(', ')}</Ltr> : '—'}
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'm05.web.f.capabilities')}</dt>
            <dd style={{ margin: 0 }}>
              <CapabilityList locale={locale} caps={i.capabilities} />
            </dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'field.created')}</dt>
            <dd style={{ margin: 0 }}>{formatDateTime(i.createdAt, locale)}</dd>
          </div>
          <div className="nz-row">
            <dt className="nz-muted">{t(locale, 'm05.web.f.id')}</dt>
            <dd style={{ margin: 0 }}>
              <Ltr>{i.id}</Ltr>
            </dd>
          </div>
        </dl>
      </section>

      {p.canAct && !gone && (
        <section className="nz-card" aria-labelledby="inst-actions">
          <h2 className="nz-h2" id="inst-actions">
            {t(locale, 'm05.web.actions.title')}
          </h2>
          {actions.length === 0 ? (
            <p className="nz-muted">{t(locale, 'm05.web.actions.none')}</p>
          ) : (
            <>
              <div className="nz-row" role="group" aria-label={t(locale, 'm05.web.actions.title')}>
                {actions
                  .filter((x) => x !== 'resize')
                  .map((type) => (
                    <Button
                      key={type}
                      variant="secondary"
                      disabled={a.busy || uncertain || !actionAllowed(type, i.status)}
                      aria-describedby="act-help"
                      onClick={() => act(type)}
                    >
                      {t(locale, `m05.web.act.${type}`)}
                    </Button>
                  ))}
              </div>
              {actions.includes('resize') && (
                <div className="nz-row" style={{ alignItems: 'flex-end' }}>
                  <Field id="resize-to" label={t(locale, 'm05.web.resize.label')}>
                    {(x) => (
                      <Select {...x} value={resizeTo} onChange={(e) => setResizeTo(e.target.value)}>
                        <option value="">{t(locale, 'm05.web.resize.choose')}</option>
                        {sizes.map((o) => (
                          <option key={o.offerId} value={o.offerId}>
                            {t(locale, 'm05.web.resize.option', {
                              vcpu: o.plan.vcpu,
                              memory: memoryLabel(o.plan.memoryMb),
                              price: moneyText(o.price.amount, o.price.currency, locale),
                            })}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button
                    variant="secondary"
                    disabled={
                      a.busy || uncertain || !resizeTo || !actionAllowed('resize', i.status)
                    }
                    onClick={() => act('resize', { offerId: resizeTo })}
                  >
                    {t(locale, 'm05.web.act.resize')}
                  </Button>
                </div>
              )}
              <p className="nz-help" id="act-help">
                {t(locale, 'm05.web.actions.help')}
              </p>
            </>
          )}
        </section>
      )}

      {p.canDelete && !gone && (
        <section className="nz-card" aria-labelledby="inst-delete">
          <h2 className="nz-h2" id="inst-delete">
            {t(locale, 'm05.web.delete.title')}
          </h2>
          {i.deletionProtected && (
            <p className="nz-muted">{t(locale, 'm05.web.delete.protected')}</p>
          )}
          {!confirming ? (
            <Button
              variant="danger"
              disabled={a.busy || i.deletionProtected === true}
              onClick={() => setConfirming(true)}
            >
              {t(locale, 'm05.web.delete.start')}
            </Button>
          ) : (
            <div role="group" aria-label={t(locale, 'm05.web.delete.title')}>
              <p>{t(locale, 'm05.web.delete.confirm', { name: i.name })}</p>
              <div className="nz-row">
                <Button variant="danger" disabled={a.busy} onClick={remove}>
                  {t(locale, 'm05.web.delete.confirmBtn')}
                </Button>
                <Button variant="secondary" disabled={a.busy} onClick={() => setConfirming(false)}>
                  {t(locale, 'action.cancel')}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      {a.problem ? (
        <ProblemAlert locale={locale} problem={a.problem} />
      ) : (
        <NoticeText notice={a.notice} />
      )}
      {a.panel}
      {p.operation && <OperationTimeline locale={locale} op={p.operation} />}
      {i.status === 'deleted' && (
        <ButtonLink variant="secondary" href={`/${locale}/compute/instances`}>
          {t(locale, 'm05.web.instances.title')}
        </ButtonLink>
      )}
    </>
  );
}
