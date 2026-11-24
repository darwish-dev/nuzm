import type { ComponentProps, ReactNode } from 'react';
import { formatMinor, t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Banner, EmptyState, Ltr, Meter } from '@nuzm/ui';
import {
  isIsolated,
  runMeters,
  runWarns,
  type Run,
  type RunMeter,
  type Runtime,
} from '../lib/appbuilder';
import { SectionTabs } from './DataParts';

/** Server-safe presentational pieces of the app-builder screens. No state, no I/O. */

export type BuilderSection =
  'overview' | 'spec' | 'design' | 'ide' | 'tests' | 'deployments' | 'exports' | 'versions';

const TAB_LABEL: Record<BuilderSection, MessageKey> = {
  overview: 'm10.tab.overview',
  spec: 'm10a.tab.spec',
  design: 'm10a.tab.design',
  ide: 'm10a.tab.ide',
  tests: 'm10.tab.tests',
  deployments: 'm10.tab.deployments',
  exports: 'm10.tab.exports',
  versions: 'm10a.tab.versions',
};

/**
 * Section links of one web-app project: overview (agent run), app spec, generated data/API/access, files and sandbox, tests, deployments, exports, versions.
 * Only sections that have a page are listed (the Git changes and budget screens are not built in M10A).
 */
export function BuilderTabs({
  locale,
  id,
  current,
}: {
  locale: Locale;
  id: string;
  current: BuilderSection;
}) {
  const base = `/${locale}/builder/projects/${id}`;
  const tab = (key: BuilderSection, path: string) => ({
    key,
    href: `${base}${path}`,
    label: t(locale, TAB_LABEL[key]),
  });
  return (
    <SectionTabs
      locale={locale}
      label={t(locale, 'm10.tab.nav')}
      current={current}
      tabs={[
        tab('overview', ''),
        tab('spec', '/spec'),
        tab('design', '/design'),
        tab('ide', '/ide'),
        tab('tests', '/tests'),
        tab('deployments', '/deployments'),
        tab('exports', '/exports'),
        tab('versions', '/versions'),
      ]}
    />
  );
}

/**
 * A builder capability is off for this organization or the item does not exist (the API answers 404 for all three). `capability` names what the gate found missing:
 * the app builder (`app_builder.enabled`, the default) or the AI capability (`ai.enabled`) the builder API also requires. No flag key or internal is shown.
 */
export function NotEnabledState({
  locale,
  capability = 'app_builder',
}: {
  locale: Locale;
  capability?: 'app_builder' | 'ai';
}) {
  return capability === 'ai' ? (
    <EmptyState title={t(locale, 'bt.gate.ai.title')} body={t(locale, 'bt.gate.ai.body')} />
  ) : (
    <EmptyState title={t(locale, 'm10.notEnabled.title')} body={t(locale, 'm10.notEnabled.body')} />
  );
}

/**
 * The runtime of a sandbox, stated as it is: `runtime.kind` and `runtime.isolation` always, and, unless the isolation is `verified`, the visible notice
 * that this is a development stand-in and NOT isolated. (Until D-21/HG-10-02 the API never answers `verified`.)
 */
export function SandboxRuntime({ locale, runtime }: { locale: Locale; runtime: Runtime }) {
  return (
    <>
      <p>
        <span className="nz-muted">{t(locale, 'm10.sbx.runtime')}: </span>
        <Badge tone={isIsolated(runtime) ? 'success' : 'warn'}>
          <Ltr>{runtime?.kind ?? '—'}</Ltr>
        </Badge>{' '}
        <span className="nz-muted">{t(locale, 'm10.sbx.isolation')}: </span>
        <Badge tone={isIsolated(runtime) ? 'success' : 'warn'}>
          <Ltr>{runtime?.isolation ?? '—'}</Ltr>
        </Badge>
      </p>
      {!isIsolated(runtime) && <Banner tone="warn">{t(locale, 'm10.sbx.notIsolated')}</Banner>}
    </>
  );
}

const meterText = (locale: Locale, m: RunMeter): string =>
  m.key === 'cost'
    ? `${formatMinor(String(m.used), 'SAR', locale)} / ${formatMinor(String(m.max), 'SAR', locale)}`
    : m.key === 'minutes'
      ? `${m.used} / ${m.max} ${t(locale, 'm10.run.minutesUnit')}`
      : `${m.used.toLocaleString('en-US')} / ${m.max.toLocaleString('en-US')}`;

/** The live budget meters of a run (tokens, cost in SAR minor units, minutes). From 80 % on every affected meter and a plain warning say so. */
export function BudgetMeters({
  locale,
  run,
}: {
  locale: Locale;
  run: Pick<Run, 'budget' | 'usage' | 'budgetRemaining'> & { warn?: boolean };
}) {
  const meters = runMeters(run);
  return (
    <div aria-label={t(locale, 'm10.run.budget')} role="group">
      {runWarns(run) && <Banner tone="warn">{t(locale, 'm10.run.budgetWarn')}</Banner>}
      <dl>
        {meters.map((m) => (
          <div key={m.key}>
            <dt>
              {t(locale, `m10.run.meter.${m.key}`)}{' '}
              {m.level !== 'ok' && (
                <Badge tone={m.level === 'exceeded' ? 'danger' : 'warn'}>
                  {t(locale, m.level === 'exceeded' ? 'm10.run.exceeded' : 'm10.run.warn80')}
                </Badge>
              )}
            </dt>
            <dd>
              <Meter label={t(locale, `m10.run.meter.${m.key}`)} percent={m.pct} />
              <Ltr>{meterText(locale, m)}</Ltr> <span className="nz-muted">({m.pct}%)</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Multi-line input in the console's input style. */
export const TextArea = (p: ComponentProps<'textarea'>) => (
  <textarea className="nz-input" style={{ paddingBlock: 8, resize: 'vertical' }} {...p} />
);

/** A state/status word in the user's language (unknown values are shown as the service sent them). */
export function Word({ locale, prefix, value }: { locale: Locale; prefix: string; value: string }) {
  return <>{tDynamic(locale, `${prefix}.${value}`, value)}</>;
}

/** A pre-formatted block (action JSON, logs, code): left-to-right, scrollable, focusable so the keyboard can scroll it. */
export function Code({ children, label }: { children: ReactNode; label: string }) {
  return (
    <pre
      className="nz-card"
      dir="ltr"
      role="region"
      tabIndex={0}
      aria-label={label}
      style={{
        overflow: 'auto',
        maxBlockSize: 420,
        margin: 0,
        textAlign: 'start',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      <code>{children}</code>
    </pre>
  );
}
