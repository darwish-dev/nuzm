import { formatDateTime, t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, EmptyState, Ltr, Table } from '@nuzm/ui';
import { runTone } from '../lib/appbuilder';
import { manifestView, declaredPermissions, type ScreenView } from '../lib/mobile';
import { RunAutoRefresh } from './RunAutoRefresh';

/**
 * UI-M10-13: what was generated for a mobile project. There is no web preview of a Flutter app yet (it needs a web build worker), so the screen says that plainly,
 * lists the screens of the approved design, and states on every render that a preview is not a guarantee of device behaviour.
 */
export function MobileOverview({
  locale,
  manifest,
  run,
}: {
  locale: Locale;
  manifest: unknown;
  run: { id: string; state: string; createdAt?: string } | null;
}) {
  const m = manifestView(manifest);
  const generated = m.fileCount > 0 && m.screens.length > 0;
  const title = (s: ScreenView) =>
    locale === 'ar' ? s.title.ar || s.title.en : s.title.en || s.title.ar;
  return (
    <>
      <Banner tone="warn">{t(locale, 'mobile.preview.notice')}</Banner>
      {run && (run.state === 'queued' || run.state === 'running') && <RunAutoRefresh />}
      {run && (
        <section aria-labelledby="mobile-run-h">
          <h2 className="nz-h2" id="mobile-run-h">
            {t(locale, 'mobile.preview.run')}
          </h2>
          <p>
            <Badge tone={runTone(run.state)}>
              {tDynamic(locale, `mobile.preview.runState.${run.state}`, run.state)}
            </Badge>
            {run.createdAt && (
              <>
                {' '}
                <span className="nz-muted">{formatDateTime(run.createdAt, locale)}</span>
              </>
            )}
          </p>
          <p>
            <ButtonLink variant="secondary" href={`/${locale}/builder/runs/${run.id}`}>
              {t(locale, 'mobile.preview.openRun')}
            </ButtonLink>
          </p>
        </section>
      )}
      <EmptyState
        title={t(locale, 'mobile.preview.unavailableTitle')}
        body={t(locale, 'mobile.preview.unavailableBody')}
      />
      {!generated ? (
        <EmptyState
          title={t(locale, 'mobile.preview.empty.title')}
          body={t(locale, 'mobile.preview.empty.body')}
        />
      ) : (
        <>
          <dl>
            <dt>{t(locale, 'mobile.preview.appName')}</dt>
            <dd>
              <bdi dir="auto">
                {m.appName ? title({ id: '', kind: '', title: m.appName }) : '—'}
              </bdi>
            </dd>
            <dt>{t(locale, 'mobile.preview.appId')}</dt>
            <dd>
              <Ltr>{m.applicationId ?? '—'}</Ltr>
            </dd>
            <dt>{t(locale, 'mobile.preview.files')}</dt>
            <dd>
              <Ltr>{String(m.fileCount)}</Ltr>
            </dd>
            <dt>{t(locale, 'mobile.preview.toolchain')}</dt>
            <dd>
              <Ltr>
                Flutter {m.toolchain.flutter ?? '?'} · Dart {m.toolchain.dart ?? '?'}
              </Ltr>
            </dd>
            <dt>{t(locale, 'mobile.preview.permissions')}</dt>
            <dd>
              {declaredPermissions(m).map((p) => (
                <Badge key={p}>{t(locale, `mobile.wizard.permission.${p}` as MessageKey)}</Badge>
              ))}
            </dd>
          </dl>
          <Table
            caption={t(locale, 'mobile.preview.screens')}
            rows={m.screens}
            rowKey={(s) => s.id}
            columns={[
              {
                key: 'title',
                header: t(locale, 'mobile.preview.screens'),
                card: 'title',
                render: (s) => <bdi dir="auto">{title(s)}</bdi>,
              },
              {
                key: 'kind',
                header: t(locale, 'mobile.builds.col.kind'),
                card: 'badge',
                render: (s) => t(locale, `mobile.kind.${s.kind}` as MessageKey),
              },
              { key: 'id', header: 'id', card: 'meta', render: (s) => <Ltr>{s.id}</Ltr> },
              {
                key: 'tab',
                header: t(locale, 'mobile.preview.tab'),
                card: 'chip',
                render: (s) => (m.tabs.includes(s.id) ? t(locale, 'mobile.preview.tab') : ''),
              },
            ]}
          />
        </>
      )}
      <p>
        <ButtonLink variant="secondary" href={`/${locale}/mobile/new`}>
          {t(locale, 'mobile.preview.newDesign')}
        </ButtonLink>
      </p>
    </>
  );
}
