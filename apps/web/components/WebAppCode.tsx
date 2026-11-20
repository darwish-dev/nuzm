'use client';
import { useEffect, useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { EmptyState, Icon } from '@nuzm/ui';
import type { Sandbox } from '../lib/appbuilder';
import { CodePane } from './BuilderCode';
import { RunPanel } from './BuilderIde';
import { Gate } from './PanelLoad';
import { gone, useApi } from './WebAppLoad';
import type { AppCan } from './WebAppPanels';

/**
 * The Code panel of the web-app studio: the same Code view as the website studio (file tree with type glyphs, search over names and contents, a line-numbered
 * read-only viewer, copy, a version selector with "changed in this version" markers, the changes and the last publish in the bottom panel), over the generated
 * project's files. The sandbox (start one, run a test suite in it) stays one click away as the second view of the same panel, with its permission checks. Needs
 * `sandbox:use`, as the former IDE page did. `open` makes the panel show a file (a link from the chat).
 */
export function AppCodePanel({
  locale,
  projectId,
  headVersionId,
  can,
  mfaFactorId,
  refresh,
  open = null,
}: {
  locale: Locale;
  projectId: string;
  headVersionId: string | null;
  can: AppCan;
  mfaFactorId: string | null;
  refresh: number;
  open?: { path: string; n: number } | null;
}) {
  const [view, setView] = useState<'files' | 'sandbox'>('files');
  // a link to a file shows the files again
  useEffect(() => {
    if (open) setView('files');
  }, [open]);
  const views = [
    { id: 'files', icon: 'code', label: t(locale, 'wsp.code.files') },
    { id: 'sandbox', icon: 'hosting', label: t(locale, 'wsp.code.sandbox') },
  ] as const;
  return (
    <div className="wsp-pane" data-pane="code">
      <h2 className="nz-sr">{t(locale, 'm10a.tab.ide')}</h2>
      <div className="wsp-subbar" role="tablist" aria-label={t(locale, 'm10a.tab.ide')}>
        {views.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            onClick={() => setView(v.id)}
          >
            <Icon name={v.icon} size={15} />
            {v.label}
          </button>
        ))}
      </div>
      {view === 'files' ? (
        headVersionId ? (
          <CodePane
            locale={locale}
            projectId={projectId}
            versionId={headVersionId}
            history
            openPath={open}
          />
        ) : (
          <div className="wsp-scroll">
            <EmptyState
              title={t(locale, 'wsp.code.none.title')}
              body={t(locale, 'wsp.code.none.body')}
            />
          </div>
        )
      ) : (
        <SandboxView
          locale={locale}
          projectId={projectId}
          can={can}
          mfaFactorId={mfaFactorId}
          refresh={refresh}
        />
      )}
    </div>
  );
}

/** Start a sandbox and run a test suite in it (the former IDE page's run panel, with its permission checks). */
function SandboxView({
  locale,
  projectId,
  can,
  mfaFactorId,
  refresh,
}: {
  locale: Locale;
  projectId: string;
  can: AppCan;
  mfaFactorId: string | null;
  refresh: number;
}) {
  const [boxes, retry] = useApi<{ items: Sandbox[] }>(
    `/v1/builder/projects/${projectId}/sandboxes`,
    undefined,
    refresh,
  );
  return (
    <div className="wsp-scroll">
      <Gate locale={locale} load={boxes} retry={retry} gone={gone(locale)}>
        {(s) => (
          <RunPanel
            locale={locale}
            projectId={projectId}
            initial={s.items}
            canUse={can.sandbox}
            canTest={can.test}
            mfaFactorId={mfaFactorId}
          />
        )}
      </Gate>
    </div>
  );
}
