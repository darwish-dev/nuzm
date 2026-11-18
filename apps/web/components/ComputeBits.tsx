import { formatDateTime, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Ltr } from '@nuzm/ui';
import {
  OP_TERMINAL,
  capabilitySet,
  driftTone,
  problemKey,
  statusTone,
  timelineOf,
  type ComputeProblem,
  type OperationView,
} from '../lib/compute';

/** Section links shared by the compute screens; only sections the caller may open are listed. */
export function ComputeTabs({
  locale,
  current,
  can,
}: {
  locale: Locale;
  current: 'offers' | 'instances' | 'new' | 'approvals';
  can: (permission: string) => boolean;
}) {
  const tabs = [
    { key: 'offers', href: `/${locale}/compute/offers`, perm: 'offers:read' },
    { key: 'instances', href: `/${locale}/compute/instances`, perm: 'compute:instance:read' },
    { key: 'new', href: `/${locale}/compute/instances/new`, perm: 'compute:instance:create' },
    { key: 'approvals', href: `/${locale}/billing/approvals`, perm: 'spend:request' },
  ] as const;
  return (
    <nav aria-label={t(locale, 'm05.web.nav.label')} className="nz-row">
      {tabs
        .filter((x) => can(x.perm))
        .map((x) => (
          <a
            key={x.key}
            className="nz-btn"
            data-variant={x.key === current ? 'primary' : 'secondary'}
            href={x.href}
            aria-current={x.key === current ? 'page' : undefined}
          >
            {t(locale, `m05.web.tab.${x.key}`)}
          </a>
        ))}
    </nav>
  );
}

/** A problem+json mapped to a localised message by its code (never the raw server text), plus the trace id for support. */
export function ProblemAlert({
  locale,
  problem,
  children,
}: {
  locale: Locale;
  problem: ComputeProblem;
  children?: React.ReactNode;
}) {
  return (
    <div role="alert" className="nz-error-text">
      <strong>{t(locale, problemKey(problem))}</strong>
      {problem.code === 'spend_approval_required' && (
        <p>
          <a href={`/${locale}/billing/approvals`}>{t(locale, 'm05.web.err.approvalLink')}</a>
          {problem.approvalId && (
            <>
              {' '}
              <Ltr>{problem.approvalId.slice(0, 8)}</Ltr>
            </>
          )}
        </p>
      )}
      {children}
      {problem.traceId && (
        <p className="nz-muted">{t(locale, 'state.error.trace', { traceId: problem.traceId })}</p>
      )}
    </div>
  );
}

/** Status badge plus a drift badge when the platform and the provider disagree. */
export function InstanceBadges({
  locale,
  status,
  driftState,
}: {
  locale: Locale;
  status: string;
  driftState: string;
}) {
  return (
    <span className="nz-row">
      <Badge tone={statusTone(status)}>
        {tDynamic(locale, `m05.web.status.${status.toLowerCase()}`, status)}
      </Badge>
      {driftState !== 'in_sync' && (
        <Badge tone={driftTone(driftState)}>
          {tDynamic(locale, `m05.web.drift.${driftState}`, driftState)}
        </Badge>
      )}
    </span>
  );
}

/** Capability ids as readable labels (unknown ids are shown as-is: nothing is invented). */
export function CapabilityList({ locale, caps }: { locale: Locale; caps: readonly string[] }) {
  const list = [...capabilitySet(caps)];
  if (list.length === 0) return <span className="nz-muted">—</span>;
  return (
    <span className="nz-row">
      {list.map((c) => (
        <Badge key={c}>{tDynamic(locale, `m05.web.cap.${c}`, c)}</Badge>
      ))}
    </span>
  );
}

/** What the operation did and where it stands: created, durable steps, retries, cancellation, error code, current state. */
export function OperationTimeline({ locale, op }: { locale: Locale; op: OperationView }) {
  const entries = timelineOf(op);
  const done = OP_TERMINAL.has(op.state);
  return (
    <section className="nz-card" aria-labelledby="op-timeline">
      <h2 className="nz-h2" id="op-timeline">
        {t(locale, 'm05.web.timeline.title')}
      </h2>
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'grid',
          gap: 'var(--nuzm-space-2)',
        }}
      >
        {entries.map((e) => (
          <li key={e.key} className="nz-row">
            {e.kind === 'state' ? (
              <Badge tone={e.tone}>{tDynamic(locale, `m05.web.opstate.${e.value}`, e.value)}</Badge>
            ) : e.kind === 'error' ? (
              <Badge tone="danger">
                <Ltr>{e.value}</Ltr>
              </Badge>
            ) : null}
            <span>
              {e.kind === 'created' && t(locale, 'm05.web.timeline.created')}
              {e.kind === 'step' &&
                t(locale, 'm05.web.timeline.step', {
                  step: tDynamic(locale, `m05.web.step.${e.value}`, e.value),
                })}
              {e.kind === 'attempts' && t(locale, 'm05.web.timeline.attempts', { n: e.value })}
              {e.kind === 'cancel' && t(locale, 'm05.web.timeline.cancel')}
              {e.kind === 'error' && t(locale, 'm05.web.timeline.error')}
              {e.kind === 'state' &&
                t(locale, done ? 'm05.web.timeline.finished' : 'm05.web.timeline.current')}
            </span>
            {e.at && <span className="nz-muted">{formatDateTime(e.at, locale)}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
