import { notFound } from 'next/navigation';
import { ApiError, unwrap } from '@nuzm/sdk';
import { formatDateTime, isLocale, t, tDynamic } from '@nuzm/i18n';
import { Badge, Banner, Card, EmptyState, ForbiddenState, Ltr, PageTitle } from '@nuzm/ui';
import {
  CopyValue,
  SsoConnectionControls,
  SsoCreateForm,
} from '../../../../../../components/SsoPanels';
import { requireSession } from '../../../../../../lib/server';
import {
  canEnforce,
  readDomains,
  readJit,
  readPublicConfig,
  testLoginSucceeded,
} from '../../../../../../lib/sso';
import { view } from '../../../../../../lib/view';

/**
 * UI-M12-01: SSO connections (feature flag `enterprise.sso`: the API answers 404 while it is off, shown here as "not enabled"). Shows the DNS TXT proof
 * to copy, JIT and enforcement. The test login is shown DISABLED (SCR-M12-05) and enforcement stays unavailable until a test login has succeeded.
 * Certificates and secrets are never displayed: the API sends only the number of signing certificates, and OIDC secrets are vault references.
 */
export default async function Sso({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const s = await requireSession(locale);
  if (!s.org || !s.can('org:security'))
    return (
      <>
        <PageTitle>{t(locale, 'm12.sso.title')}</PageTitle>
        <ForbiddenState
          title={t(locale, 'state.forbidden.title')}
          body={t(locale, 'state.forbidden.body')}
        />
      </>
    );
  const orgId = s.org.orgId;
  const factor = s.me.mfaFactorId ?? null;
  const body = await view(
    locale,
    async () => {
      try {
        return await unwrap(
          s.api.GET('/v1/organizations/{orgId}/sso-connections', { params: { path: { orgId } } }),
        );
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return null; // the capability is off for this organization
        throw e;
      }
    },
    (data) => {
      if (data === null)
        return (
          <EmptyState
            title={t(locale, 'm12.sso.flagOff.title')}
            body={t(locale, 'm12.sso.flagOff.body')}
          />
        );
      return (
        <>
          {data.items.length === 0 ? (
            <EmptyState title={t(locale, 'm12.sso.none')} body={t(locale, 'm12.sso.noneBody')} />
          ) : (
            data.items.map((c) => {
              const domains = readDomains(c.domains);
              const jit = readJit(c.jit);
              const cfg = readPublicConfig(c.config);
              const sp = readPublicConfig(c.sp);
              const enforceable = canEnforce({ status: c.status, domains, testLogin: c.testLogin });
              return (
                <Card key={c.id} aria-labelledby={`sso-${c.id}`}>
                  <h2 className="nz-h2" id={`sso-${c.id}`}>
                    {c.name ?? c.id}
                  </h2>
                  <p>
                    <Badge>{t(locale, `m12.sso.protocol.${c.protocol}`)}</Badge>{' '}
                    <Badge
                      tone={
                        c.status === 'active'
                          ? 'success'
                          : c.status === 'disabled'
                            ? undefined
                            : 'warn'
                      }
                    >
                      {tDynamic(locale, `m12.sso.status.${c.status}`, c.status)}
                    </Badge>{' '}
                    {c.enforce && <Badge tone="danger">{t(locale, 'm12.sso.enforce.badge')}</Badge>}
                    {c.createdAt && (
                      <span className="nz-muted"> {formatDateTime(c.createdAt, locale)}</span>
                    )}
                  </p>
                  <ul>
                    {cfg.entityId && (
                      <li>
                        {t(locale, 'm12.sso.idpEntity')}: <Ltr>{cfg.entityId}</Ltr>
                      </li>
                    )}
                    {cfg.ssoUrl && (
                      <li>
                        {t(locale, 'm12.sso.ssoUrl')}: <Ltr>{cfg.ssoUrl}</Ltr>
                      </li>
                    )}
                    {cfg.issuer && (
                      <li>
                        {t(locale, 'm12.sso.create.issuer')}: <Ltr>{cfg.issuer}</Ltr>
                      </li>
                    )}
                    {cfg.clientId && (
                      <li>
                        {t(locale, 'm12.sso.create.clientId')}: <Ltr>{cfg.clientId}</Ltr>
                      </li>
                    )}
                    {c.protocol === 'saml' && cfg.signingCertificates !== null && (
                      <li>{t(locale, 'm12.sso.certs', { count: cfg.signingCertificates })}</li>
                    )}
                    <li>
                      {t(locale, 'm12.sso.idpInitiated')}:{' '}
                      {t(locale, c.idpInitiated ? 'm12.sso.on' : 'm12.sso.off')}
                    </li>
                  </ul>
                  {sp.entityId && (
                    <CopyValue
                      locale={locale}
                      id={`sp-${c.id}`}
                      label={t(locale, 'm12.sso.spEntity')}
                      value={sp.entityId}
                    />
                  )}
                  <h3>{t(locale, 'm12.sso.domains')}</h3>
                  <p className="nz-muted">{t(locale, 'm12.sso.proofHelp')}</p>
                  {domains.length === 0 ? (
                    <p>{t(locale, 'm12.none')}</p>
                  ) : (
                    domains.map((d) => (
                      <section
                        key={d.domain}
                        className="nz-card"
                        aria-label={d.domain}
                        style={{ marginBlockEnd: 12 }}
                      >
                        <p>
                          <Ltr>{d.domain}</Ltr>{' '}
                          <Badge tone={d.status === 'verified' ? 'success' : 'warn'}>
                            {t(locale, `m12.sso.proof.${d.status}`)}
                          </Badge>
                          {d.verifiedAt && (
                            <span className="nz-muted">
                              {' '}
                              {formatDateTime(d.verifiedAt, locale)}
                            </span>
                          )}
                        </p>
                        {d.status === 'pending' && d.txtValue && (
                          <>
                            <CopyValue
                              locale={locale}
                              id={`txtn-${c.id}-${d.domain}`}
                              label={t(locale, 'm12.sso.txtName')}
                              value={d.txtName}
                            />
                            <CopyValue
                              locale={locale}
                              id={`txtv-${c.id}-${d.domain}`}
                              label={t(locale, 'm12.sso.txtValue')}
                              value={d.txtValue}
                            />
                          </>
                        )}
                      </section>
                    ))
                  )}
                  <p>
                    {t(locale, 'm12.sso.lastTest')}:{' '}
                    {testLoginSucceeded(c.testLogin)
                      ? t(locale, 'm12.sso.lastTest.ok')
                      : t(locale, 'm12.sso.lastTest.none')}
                  </p>
                  <SsoConnectionControls
                    locale={locale}
                    orgId={orgId}
                    mfaFactorId={factor}
                    connectionId={c.id}
                    jit={jit}
                    enforce={c.enforce === true}
                    canEnforce={enforceable}
                  />
                </Card>
              );
            })
          )}
          <SsoCreateForm locale={locale} orgId={orgId} mfaFactorId={factor} />
        </>
      );
    },
  );
  return (
    <>
      <PageTitle>{t(locale, 'm12.sso.title')}</PageTitle>
      <Banner tone="warn">{t(locale, 'm12.sso.testBanner')}</Banner>
      <p className="nz-muted">{t(locale, 'm12.sso.help')}</p>
      {body}
    </>
  );
}
