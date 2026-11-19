import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, EmptyState, Ltr, Table } from '@nuzm/ui';
import { biText, declaredPermissions, manifestSpec, manifestView } from '../lib/mobile';

/**
 * The Spec panel of the mobile workspace: what the approved design says, in plain terms: the app name and application id, the theme, the sign-in, the declared
 * permissions, the bottom navigation and every screen with its kind. It reads the project's manifest (the spec the Flutter project was generated from) and
 * invents nothing; a project with no generated design says so.
 */
export function MobileSpecPane({ locale, manifest }: { locale: Locale; manifest: unknown }) {
  const m = manifestView(manifest);
  const spec = manifestSpec(manifest);
  if (m.fileCount === 0 || !spec)
    return (
      <EmptyState
        title={t(locale, 'mobile.preview.empty.title')}
        body={t(locale, 'mobile.preview.empty.body')}
      />
    );
  const lang = locale === 'ar' ? 'ar' : 'en';
  return (
    <div className="mws-spec">
      <dl className="mws-dl">
        <dt>{t(locale, 'mobile.preview.appName')}</dt>
        <dd>
          <bdi dir="auto">{biText(spec.app.name, lang) || '—'}</bdi>
        </dd>
        <dt>{t(locale, 'mobile.preview.appId')}</dt>
        <dd>
          <Ltr>{spec.app.packageId || '—'}</Ltr>
        </dd>
        <dt>{t(locale, 'mws.spec.theme')}</dt>
        <dd>
          <span
            className="mws-swatch"
            style={{ background: spec.theme.primary }}
            aria-hidden="true"
          />{' '}
          <Ltr>{spec.theme.primary}</Ltr> ·{' '}
          {t(locale, spec.theme.dark ? 'mws.spec.dark' : 'mws.spec.light')}
        </dd>
        <dt>{t(locale, 'mws.spec.defaultLocale')}</dt>
        <dd>
          {t(
            locale,
            spec.defaultLocale === 'ar' ? 'mobile.wizard.arLabel' : 'mobile.wizard.enLabel',
          )}
        </dd>
        <dt>{t(locale, 'mws.spec.auth')}</dt>
        <dd>{t(locale, spec.auth ? 'mws.spec.authOn' : 'mws.spec.authOff')}</dd>
        <dt>{t(locale, 'mobile.preview.permissions')}</dt>
        <dd>
          {declaredPermissions(m).map((p) => (
            <Badge key={p}>{t(locale, `mobile.wizard.permission.${p}` as MessageKey)}</Badge>
          ))}
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
      </dl>
      <Table
        caption={t(locale, 'mobile.preview.screens')}
        rows={spec.screens}
        rowKey={(s) => s.id}
        columns={[
          {
            key: 'title',
            header: t(locale, 'mobile.preview.screens'),
            card: 'title',
            render: (s) => <bdi dir="auto">{biText(s.title, lang)}</bdi>,
          },
          {
            key: 'kind',
            header: t(locale, 'mobile.builds.col.kind'),
            card: 'badge',
            render: (s) => tDynamic(locale, `mobile.kind.${s.kind}`, s.kind),
          },
          { key: 'id', header: 'id', card: 'meta', render: (s) => <Ltr>{s.id}</Ltr> },
          {
            key: 'tab',
            header: t(locale, 'mobile.preview.tab'),
            card: 'chip',
            render: (s) =>
              spec.navigation.tabs.includes(s.id) ? t(locale, 'mobile.preview.tab') : '',
          },
        ]}
      />
    </div>
  );
}
