import type { ReactNode } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import { Badge, Button, Card, EmptyState } from '@nuzm/ui';
import type { Tone } from '../lib/data';

/** Server-safe presentational pieces of the M11 screens. No state, no I/O. */

/** A translated status word (`prefix.value`, the raw value when untranslated) as a badge. */
export function Status({
  locale,
  prefix,
  value,
  tone,
}: {
  locale: Locale;
  prefix: string;
  value: string;
  tone?: Tone;
}) {
  return <Badge tone={tone}>{tDynamic(locale, `${prefix}.${value}`, value)}</Badge>;
}

/**
 * An action that exists in the design but is not approved or not available: rendered as a DISABLED button with the reason next to it (never hidden, never faked).
 * `reason` is referenced by `aria-describedby`, so assistive technology reads why the control is off.
 */
export function DisabledAction({
  id,
  label,
  reason,
}: {
  id: string;
  label: string;
  reason: string;
}) {
  return (
    <span className="nz-row">
      <Button variant="secondary" disabled aria-disabled="true" aria-describedby={id}>
        {label}
      </Button>
      <span id={id} className="nz-muted">
        {reason}
      </span>
    </span>
  );
}

/** A screen (or part of one) that cannot work yet: says BLOCKED, why, and what is missing. */
export function BlockedState({
  locale,
  title,
  body,
  missing,
  status = 'BLOCKED',
}: {
  locale: Locale;
  title: string;
  body: string;
  missing?: string;
  status?: string;
}) {
  return (
    <Card aria-label={title}>
      <p>
        <Badge tone="warn">{status}</Badge>
      </p>
      <h2 className="nz-h2">{title}</h2>
      <p>{body}</p>
      {missing && (
        <p className="nz-muted">
          {t(locale, 'm11.blocked.missing')} {missing}
        </p>
      )}
    </Card>
  );
}

/** The feature flag of the area is off for this organization (the API answers 403 `feature_disabled` / 404 until it is on). */
export function FeatureOff({ locale }: { locale: Locale }) {
  return (
    <EmptyState
      title={t(locale, 'm11.state.featureOff.title')}
      body={t(locale, 'm11.state.featureOff.body')}
    />
  );
}

/** A labelled section with an optional explanation. */
export function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <section style={{ marginBlockStart: 16 }}>
      <h2 className="nz-h2">{title}</h2>
      {help && <p className="nz-muted">{help}</p>}
      {children}
    </section>
  );
}

/** Tabs of a section as plain links (the current one is marked), like the other consoles. */
export function LinkTabs({
  locale,
  label,
  tabs,
  current,
}: {
  locale: Locale;
  label: string;
  tabs: { id: string; href: string; label: MessageKey }[];
  current: string;
}) {
  return (
    <nav aria-label={label} className="nz-row" style={{ marginBlockEnd: 16 }}>
      {tabs.map((x) => (
        <a
          key={x.id}
          href={x.href}
          aria-current={x.id === current ? 'page' : undefined}
          style={{ fontWeight: x.id === current ? 700 : 400 }}
        >
          {t(locale, x.label)}
        </a>
      ))}
    </nav>
  );
}
