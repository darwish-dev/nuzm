import { notFound } from 'next/navigation';
import { unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, EmptyState, Ltr, PageTitle, Table } from '@nuzm/ui';
import { BillingAdminTabs } from '../../../../../components/BillingAdminTabs';
import { DecideStep, RequestStepButton } from '../../../../../components/FinancePanels';
import { nextZatcaStep, stepTone, type ZatcaStep } from '../../../../../lib/finance';
import { requireStaff } from '../../../../../lib/server';
import { view } from '../../../../../lib/view';

/**
 * UI-M03-18: e-invoicing onboarding. Every environment is SIMULATED (HG-03-03: no official ZATCA documents). Production is locked: the
 * API never enables it, and the page says so. Credentials are shown as references only (kind, serial, expiry); a secret is never returned.
 */
export default async function Zatca({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireStaff(locale);
  const canRequest = s.can('admin:zatca:manage');
  const canDecide = s.can('admin:zatca:approve');
  const mfa = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    () => unwrap(s.api.GET('/v1/admin/billing/zatca/onboarding', {})),
    ({ items }) =>
      items.length === 0 ? (
        <EmptyState title={t(locale, 'af.z.none')} body={t(locale, 'af.z.noneBody')} />
      ) : (
        <>
          {items.map((env) => {
            const next = nextZatcaStep(env.state);
            const pending = env.steps.some((x) => x.status === 'pending_approval');
            return (
              <section key={env.environment} aria-labelledby={`env-${env.environment}`}>
                <h2 className="nz-h2" id={`env-${env.environment}`}>
                  {t(locale, 'af.z.env', { env: env.environment.toUpperCase() })}{' '}
                  <Badge tone={env.onboarded ? 'success' : 'warn'}>
                    {env.onboarded ? t(locale, 'af.z.onboarded') : t(locale, 'af.z.notOnboarded')}
                  </Badge>
                </h2>
                <Banner tone="warn">
                  {tDynamic(locale, `af.z.banner.${env.environment}`, env.environment)}
                </Banner>
                <p>
                  {t(locale, 'af.z.state')}:{' '}
                  <strong>
                    {env.state === 'not_started'
                      ? t(locale, 'af.z.notStarted')
                      : tDynamic(locale, `af.z.step.${env.state}`, env.state)}
                  </strong>
                </p>
                <h3 className="nz-h2">{t(locale, 'af.z.steps')}</h3>
                {env.steps.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'af.z.steps.none')}</p>
                ) : (
                  <Table
                    caption={`${t(locale, 'af.z.steps')} — ${env.environment}`}
                    rows={env.steps}
                    rowKey={(x) => x.id}
                    columns={[
                      {
                        key: 's',
                        header: t(locale, 'af.z.col.step'),
                        render: (x) => tDynamic(locale, `af.z.step.${x.step}`, x.step),
                      },
                      {
                        key: 't',
                        header: t(locale, 'af.z.col.status'),
                        render: (x) => (
                          <Badge tone={stepTone(x.status)}>
                            {tDynamic(locale, `af.z.stepStatus.${x.status}`, x.status)}
                          </Badge>
                        ),
                      },
                      {
                        key: 'w',
                        header: t(locale, 'af.z.col.when'),
                        render: (x) => formatDateTime(x.createdAt, locale),
                      },
                      {
                        key: 'd',
                        header: t(locale, 'af.z.col.actions'),
                        render: (x) =>
                          x.status === 'pending_approval' && canDecide ? (
                            <DecideStep
                              locale={locale}
                              stepId={x.id}
                              step={x.step as ZatcaStep}
                              mfaFactorId={mfa}
                            />
                          ) : (
                            '—'
                          ),
                      },
                    ]}
                  />
                )}
                {canRequest && next && !pending && (
                  <p>
                    <RequestStepButton
                      locale={locale}
                      environment={env.environment}
                      step={next}
                      mfaFactorId={mfa}
                    />
                  </p>
                )}
                {!next && <p className="nz-muted">{t(locale, 'af.z.complete')}</p>}
                <h3 className="nz-h2">{t(locale, 'af.z.creds')}</h3>
                <p className="nz-muted">{t(locale, 'af.z.credsNote')}</p>
                {env.credentials.length === 0 ? (
                  <p className="nz-muted">{t(locale, 'af.z.creds.none')}</p>
                ) : (
                  <Table
                    caption={`${t(locale, 'af.z.creds')} — ${env.environment}`}
                    rows={env.credentials}
                    rowKey={(c) => `${c.kind}-${c.serial ?? ''}`}
                    columns={[
                      {
                        key: 'k',
                        header: t(locale, 'af.z.col.kind'),
                        render: (c) => <Ltr>{c.kind}</Ltr>,
                      },
                      {
                        key: 's',
                        header: t(locale, 'af.z.col.serial'),
                        render: (c) => (c.serial ? <Ltr>{c.serial}</Ltr> : '—'),
                      },
                      {
                        key: 'e',
                        header: t(locale, 'af.z.col.expires'),
                        render: (c) => (c.expiresAt ? formatDateTime(c.expiresAt, locale) : '—'),
                      },
                    ]}
                  />
                )}
              </section>
            );
          })}
        </>
      ),
  );
  return (
    <>
      <PageTitle>{t(locale, 'af.z.title')}</PageTitle>
      <BillingAdminTabs locale={locale} current="zatca" can={s.can} />
      {body}
      <Banner tone="danger">{t(locale, 'af.z.prod')}</Banner>
      <p>
        <ButtonLink variant="secondary" href={`/${locale}/billing/zatca/submissions`}>
          {t(locale, 'af.z.openQueue')}
        </ButtonLink>
      </p>
    </>
  );
}
