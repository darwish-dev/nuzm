import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner, ButtonLink, Ltr } from '@nuzm/ui';
import { sandboxTone, type Sandbox } from '../lib/appbuilder';
import { SandboxRuntime, Word } from './BuilderParts';

/**
 * UI-M10-04: full-screen terminal layout. The terminal WebSocket and its ticket route are NOT available: they need owner approval (PA-M10-01) and no endpoint
 * is invented. The screen therefore shows the layout, the sandbox with its real runtime label, the session-ended and egress-denied notices and the explicit
 * "terminal transport not enabled" state; there is no input and nothing is executed.
 */
export function TerminalScreen({
  locale,
  projectId,
  sandbox,
}: {
  locale: Locale;
  projectId: string;
  sandbox: Sandbox;
}) {
  const ended = ['terminated', 'terminating', 'expired', 'failed'].includes(sandbox.state);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateRows: 'auto 1fr auto',
        gap: 12,
        minBlockSize: '70vh',
      }}
    >
      <header>
        <div className="nz-row">
          <Badge tone={sandboxTone(sandbox.state)}>
            <Word locale={locale} prefix="m10.sbx.state" value={sandbox.state} />
          </Badge>
          <Ltr>{sandbox.id}</Ltr>
        </div>
        <SandboxRuntime locale={locale} runtime={sandbox.runtime} />
      </header>
      <section
        aria-label={t(locale, 'm10.term.screen')}
        dir="ltr"
        style={{
          background: '#111827',
          color: '#f9fafb',
          borderRadius: 8,
          padding: 16,
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          minBlockSize: 280,
          textAlign: 'start',
        }}
      >
        <p style={{ margin: 0 }}>{t(locale, 'm10.term.disabled')}</p>
      </section>
      <footer>
        <Banner tone="warn">
          <strong>{t(locale, 'm10.term.notEnabled')}</strong> {t(locale, 'm10.term.notEnabledBody')}
        </Banner>
        {ended && <Banner tone="danger">{t(locale, 'm10.term.sessionEnded')}</Banner>}
        <Banner tone="warn">{t(locale, 'm10.term.egressDenied')}</Banner>
        <p>
          <ButtonLink variant="secondary" href={`/${locale}/builder/projects/${projectId}/ide`}>
            {t(locale, 'm10.term.back')}
          </ButtonLink>
        </p>
      </footer>
    </div>
  );
}
