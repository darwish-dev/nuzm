'use client';
import { useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Badge, Banner } from '@nuzm/ui';
import { bapi, useBuilderCall } from '../lib/builder-client';
import { ProblemNote } from './BuilderBits';

export interface AiStudioSettingsView {
  appBuilder: { enabled: boolean };
  aiStudio: { enabled: boolean };
  claudeCode: { enabled: boolean; complianceApproved: boolean; available: boolean };
}

/** The organization's own AI Studio switches (owners and admins, `org:update`). Each change is saved at once and audited. */
export function AiStudioSettings({
  locale,
  initial,
  canEdit,
}: {
  locale: Locale;
  initial: AiStudioSettingsView;
  canEdit: boolean;
}) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const call = useBuilderCall();
  const set = (patch: { aiStudio?: boolean; claudeCode?: boolean }) =>
    void call.run(
      () => bapi.put<AiStudioSettingsView>('/v1/builder/ai-studio/settings', { body: patch }),
      (d) => {
        setS(d);
        setSaved(true);
      },
    );
  const row = (
    id: string,
    label: string,
    help: string,
    on: boolean,
    disabled: boolean,
    onChange: (v: boolean) => void,
    extra?: React.ReactNode,
  ) => (
    <div className="ais-card">
      <label className="nzc-switch-row" htmlFor={id}>
        <span>
          <strong>{label}</strong> {extra}
          <br />
          <span className="nz-muted">{help}</span>
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="nzc-switch-input"
          checked={on}
          disabled={disabled || call.busy}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    </div>
  );
  return (
    <div className="ais-stack">
      {!s.appBuilder.enabled && <Banner tone="warn">{t(locale, 'ais.set.noBuilder')}</Banner>}
      {row(
        'ais-set-studio',
        t(locale, 'ais.set.studio'),
        t(locale, 'ais.set.studioHelp'),
        s.aiStudio.enabled,
        !canEdit,
        (v) => set({ aiStudio: v }),
      )}
      {row(
        'ais-set-claude',
        t(locale, 'ais.set.claude'),
        t(locale, 'ais.set.claudeHelp'),
        s.claudeCode.enabled,
        !canEdit || !s.aiStudio.enabled,
        (v) => set({ claudeCode: v }),
        <Badge tone="warn">{t(locale, 'ais.cc.poc')}</Badge>,
      )}
      {s.claudeCode.enabled && !s.claudeCode.complianceApproved && (
        <Banner tone="warn">{t(locale, 'ais.cc.compliance')}</Banner>
      )}
      {!canEdit && <p className="nz-muted">{t(locale, 'ais.set.readOnly')}</p>}
      {call.problem && <ProblemNote locale={locale} problem={call.problem} />}
      {saved && !call.problem && (
        <p role="status" className="nz-muted">
          {t(locale, 'ais.set.saved')}
        </p>
      )}
    </div>
  );
}
