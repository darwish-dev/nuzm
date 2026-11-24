'use client';
import { useId, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Ltr } from '@nuzm/ui';

/**
 * The builder agent (PHASE-2 S05): start a build from a brief, watch its 18 steps, see why it stopped, and follow the deployment approval. PRESENTATIONAL: the screen that hosts it
 * (`BuilderLifecycleScreen`) streams the run's events and passes the view in, so loading, empty, error, forbidden and offline are explicit and testable. Step and status are TEXT
 * (never colour alone); code, ids and numbers stay left-to-right inside the Arabic layout; every control is native and keyboard-operable.
 */

export const LIFECYCLE_STEPS = [
  'requirements',
  'project_analysis',
  'architecture',
  'plan',
  'tasks',
  'file_generation',
  'change_apply',
  'review',
  'execution_request',
  'build',
  'error_analysis',
  'repair',
  'repair_apply',
  'rebuild',
  'tests',
  'preview',
  'deployment_preparation',
  'deployment_approval',
] as const;
export type LifecycleStepId = (typeof LIFECYCLE_STEPS)[number];
const REPAIR_ONLY = new Set<string>(['error_analysis', 'repair', 'repair_apply', 'rebuild']);
const AFTER_REPAIR = new Set<string>([
  'tests',
  'preview',
  'deployment_preparation',
  'deployment_approval',
]);

export type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting_approval'
  | 'denied'
  | 'cancelled';
export type RunStatus = 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled';
export type PanelState = 'loading' | 'ready' | 'error' | 'forbidden' | 'offline' | 'empty';

export interface LifecycleStepView {
  id: LifecycleStepId;
  status: StepStatus;
  round: number;
  summary: string | null;
  code: string | null;
}
/** one automatic repair round, as the `lifecycle_repair` events describe it (class names and counts only: never log or file text) */
export interface RepairRoundView {
  round: number;
  classes: string[];
  strategy: 'deterministic' | 'model' | 'legacy' | 'none';
  outcome: 'pending' | 'resolved' | 'partial' | 'unchanged' | 'worse' | 'gave_up';
  asks: number;
  tokens: number;
  refused: number;
}
export interface EvidenceView {
  claim: 'SIMULATED' | 'MIXED' | 'REAL_COMPONENTS';
  models: string[];
  tokens: { in: number; out: number };
  credits: string;
  reconciled: boolean;
}
export interface LifecycleView {
  repairs: RepairRoundView[];
  evidence: EvidenceView | null;
  status: RunStatus;
  percent: number;
  done: number;
  total: number;
  current: LifecycleStepId | null;
  repairRound: number;
  tokens: number;
  credits: string;
  steps: LifecycleStepView[];
  failureCode: string | null;
  failureStep: LifecycleStepId | null;
  approvalId: string | null;
}
export interface DeploymentView {
  target: string;
  readiness: 'ready' | 'needs_attention';
  blockers: string[];
}

const isStep = (v: unknown): v is LifecycleStepId => LIFECYCLE_STEPS.includes(v as LifecycleStepId);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Rebuilds the customer's view of a lifecycle run from its persisted run events (`lifecycle_started`, `lifecycle_step`, `lifecycle_finished`). `null` = no lifecycle events yet. */
export function viewFromEvents(
  events: readonly { type: string; data?: Record<string, unknown> | null }[],
): LifecycleView | null {
  if (!events.some((e) => e.type.startsWith('lifecycle_'))) return null;
  const steps = new Map<LifecycleStepId, LifecycleStepView>(
    LIFECYCLE_STEPS.map((id) => [
      id,
      { id, status: 'pending', round: 0, summary: null, code: null },
    ]),
  );
  const v: LifecycleView = {
    repairs: [],
    evidence: null,
    status: 'running',
    percent: 0,
    done: 0,
    total: LIFECYCLE_STEPS.length - REPAIR_ONLY.size,
    current: null,
    repairRound: 0,
    tokens: 0,
    credits: '0',
    steps: [],
    failureCode: null,
    failureStep: null,
    approvalId: null,
  };
  const progress = (p: unknown) => {
    if (typeof p !== 'object' || p === null) return;
    const o = p as Record<string, unknown>;
    v.percent = Math.max(0, Math.min(100, Math.round(num(o.percent))));
    v.done = num(o.done);
    v.total = num(o.total) || v.total;
    v.repairRound = num(o.repairRound);
    v.tokens = num(o.tokens);
    if (typeof o.credits === 'string') v.credits = o.credits;
  };
  for (const e of events) {
    const d = e.data ?? {};
    if (e.type === 'lifecycle_step' && isStep(d.step)) {
      const s = steps.get(d.step)!;
      const round = num(d.round);
      // a repair step that starts again in a later round is a new row of the same step
      if (REPAIR_ONLY.has(s.id) && round > s.round) {
        s.round = round;
        s.status = 'pending';
        s.summary = null;
        s.code = null;
      }
      switch (d.status) {
        case 'started':
          s.status = 'running';
          v.current = s.id;
          break;
        case 'succeeded':
          s.status = 'succeeded';
          s.summary = typeof d.summary === 'string' ? d.summary : null;
          if (v.current === s.id) v.current = null;
          break;
        case 'retry':
          s.status = 'pending';
          s.code = typeof d.code === 'string' ? d.code : null;
          break;
        case 'failed':
          s.status = 'failed';
          s.code = typeof d.code === 'string' ? d.code : null;
          v.failureStep = s.id;
          v.failureCode = s.code;
          break;
        case 'waiting_approval':
          s.status = 'waiting_approval';
          v.status = 'waiting_approval';
          v.approvalId = typeof d.approvalId === 'string' ? d.approvalId : null;
          break;
        case 'denied':
          s.status = 'denied';
          break;
      }
      progress(d.progress);
      if (d.decision === 'approved') s.status = 'succeeded';
    } else if (e.type === 'lifecycle_repair' && num(d.round) > 0) {
      const round = num(d.round);
      let r = v.repairs.find((x) => x.round === round);
      if (!r) {
        r = {
          round,
          classes: [],
          strategy: 'none',
          outcome: 'pending',
          asks: 0,
          tokens: 0,
          refused: 0,
        };
        v.repairs.push(r);
      }
      if (Array.isArray(d.classes))
        r.classes = d.classes.filter((c): c is string => typeof c === 'string').slice(0, 12);
      if (typeof d.strategy === 'string')
        r.strategy = d.strategy.startsWith('deterministic')
          ? 'deterministic'
          : d.strategy === 'model' || d.strategy === 'legacy'
            ? d.strategy
            : 'none';
      if (
        typeof d.outcome === 'string' &&
        ['pending', 'resolved', 'partial', 'unchanged', 'worse', 'gave_up'].includes(d.outcome)
      )
        r.outcome = d.outcome as RepairRoundView['outcome'];
      if (d.asks !== undefined) r.asks = num(d.asks);
      if (d.tokens !== undefined) r.tokens = num(d.tokens);
      if (Array.isArray(d.refused)) r.refused = d.refused.length;
    } else if (e.type === 'lifecycle_evidence') {
      const claim = d.claim === 'MIXED' || d.claim === 'REAL_COMPONENTS' ? d.claim : 'SIMULATED';
      const tk = (d.tokens ?? {}) as { in?: unknown; out?: unknown };
      v.evidence = {
        claim,
        models: Array.isArray(d.models)
          ? d.models.filter((m): m is string => typeof m === 'string').slice(0, 5)
          : [],
        tokens: { in: num(tk.in), out: num(tk.out) },
        credits: typeof d.credits === 'string' ? d.credits : '0',
        reconciled: d.reconciled === true,
      };
    } else if (e.type === 'lifecycle_finished') {
      const st = d.status;
      if (st === 'succeeded' || st === 'failed' || st === 'cancelled' || st === 'waiting_approval')
        v.status = st;
      if (typeof d.code === 'string') v.failureCode = d.code;
      progress(d.progress);
      if (v.status !== 'running') v.current = null;
    }
  }
  // repair steps never needed: shown as skipped once a later step is under way
  const later = LIFECYCLE_STEPS.some(
    (id) => AFTER_REPAIR.has(id) && steps.get(id)!.status !== 'pending',
  );
  for (const s of steps.values())
    if (REPAIR_ONLY.has(s.id) && s.status === 'pending' && later && v.repairRound === 0)
      s.status = 'skipped';
  if (v.status === 'cancelled')
    for (const s of steps.values())
      if (s.status === 'pending' || s.status === 'running') s.status = 'cancelled';
  v.steps = [...steps.values()];
  if (v.status === 'succeeded') v.percent = 100;
  return v;
}

/** the code a failure shows: tool denials collapse into one message, anything unknown is "unknown" (never the raw text) */
export function failureKey(code: string | null): string {
  const known = [
    'tokens_exceeded',
    'credits_exceeded',
    'time_exceeded',
    'steps_exceeded',
    'execution_requests_exceeded',
    'repair_exhausted',
    'no_progress',
    'strategy_gave_up',
    'real_path_approval_missing',
    'model_generation_off',
    'model_unavailable',
    'real_runtime_unavailable',
    'real_runtime_simulated',
    'build_unavailable',
    'build_refused',
    'build_timeout',
    'build_terminated',
    'needs_approval',
    'approval_required',
    'change_rejected',
    'plan_invalid',
    'plan_too_large',
    'too_many_files',
    'permission_denied',
    'invalid_input',
    'invalid_model_output',
    'budget_required',
    'quota_exceeded',
    'residency_denied',
    'sandbox_quota_exceeded',
    'base_mismatch',
    'cancelled',
    'internal_error',
  ];
  if (
    code &&
    ['not_in_step', 'unknown_tool', 'model_not_allowed', 'invalid_arguments'].includes(code)
  )
    return 'bt.lc.failure.tool_denied';
  return `bt.lc.failure.${code && known.includes(code) ? code : 'unknown'}`;
}

const MAX_BRIEF = 4000;
/** a message looked up by a key built from data: an unknown one shows a dash, never the raw key or server text */
const dyn = (locale: Locale, key: string): string => tDynamic(locale, key, '—');

// ───────────────────────── start form ─────────────────────────
export function LifecycleStart({
  locale,
  busy,
  disabled,
  error,
  onStart,
}: {
  locale: Locale;
  busy: boolean;
  /** the feature is not enabled for this organization, or the member may not start runs */
  disabled: boolean;
  error?: string | null;
  onStart: (a: { prompt: string; maxRepairRounds: number }) => void;
}) {
  const id = useId();
  const [prompt, setPrompt] = useState('');
  const [rounds, setRounds] = useState(3);
  const [invalid, setInvalid] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    const text = prompt.trim();
    if (text.length < 1 || text.length > MAX_BRIEF) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onStart({ prompt: text, maxRepairRounds: rounds });
  }
  return (
    <form className="nz-card" aria-labelledby={`${id}-h`} onSubmit={submit} noValidate>
      <h2 className="nz-h2" id={`${id}-h`}>
        {t(locale, 'bt.lc.start.title')}
      </h2>
      {disabled && <Banner tone="warn">{t(locale, 'bt.lc.start.off')}</Banner>}
      <Field
        id={`${id}-p`}
        label={t(locale, 'bt.lc.start.prompt')}
        help={t(locale, 'bt.lc.start.prompt.hint')}
        {...(invalid ? { error: t(locale, 'bt.lc.failure.invalid_input') } : {})}
      >
        {(a) => (
          <textarea
            className="nz-input"
            rows={6}
            maxLength={MAX_BRIEF + 1}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled || busy}
            {...a}
          />
        )}
      </Field>
      <Field id={`${id}-r`} label={t(locale, 'bt.lc.start.rounds')}>
        {(a) => (
          <select
            className="nz-input"
            value={rounds}
            onChange={(e) => setRounds(Number(e.target.value))}
            disabled={disabled || busy}
            {...a}
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </Field>
      {error && (
        <p role="alert" className="nz-error-text">
          {error}
        </p>
      )}
      <Button type="submit" disabled={disabled || busy}>
        {t(locale, busy ? 'bt.lc.start.submitting' : 'bt.lc.start.submit')}
      </Button>
    </form>
  );
}

const TONE: Partial<Record<StepStatus, 'success' | 'danger' | 'warn'>> = {
  succeeded: 'success',
  failed: 'danger',
  denied: 'warn',
  waiting_approval: 'warn',
};

// ───────────────────────── progress ─────────────────────────
export function LifecyclePanel({
  locale,
  state,
  view,
  simulated,
  deployment,
  versionId,
  approvalsHref,
  cancelling,
  onCancel,
  onRetry,
}: {
  locale: Locale;
  state: PanelState;
  view: LifecycleView | null;
  /** the build and test results come from a mock execution */
  simulated: boolean;
  deployment?: DeploymentView | null;
  versionId?: string | null;
  approvalsHref?: string;
  cancelling?: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
}) {
  const id = useId();
  if (state === 'loading')
    return (
      <p role="status" aria-busy="true">
        {t(locale, 'bt.state.loading')}
      </p>
    );
  if (state === 'forbidden')
    return (
      <p role="alert" className="nz-error-text">
        {t(locale, 'bt.state.forbidden')}
      </p>
    );
  if (state === 'error' || state === 'offline')
    return (
      <div role="alert" className="nz-error-text">
        <p>{t(locale, state === 'offline' ? 'bt.lc.state.offline' : 'bt.state.error')}</p>
        {onRetry && (
          <Button variant="secondary" onClick={onRetry}>
            {t(locale, 'bt.lc.state.retry')}
          </Button>
        )}
      </div>
    );
  if (state === 'empty' || !view)
    return <p className="nz-muted">{t(locale, 'bt.lc.state.empty')}</p>;

  const active = view.status === 'running' || view.status === 'waiting_approval';
  return (
    <section aria-labelledby={`${id}-h`} className="nz-card">
      <h2 className="nz-h2" id={`${id}-h`}>
        {t(locale, 'bt.lc.title')}
      </h2>
      {simulated && <Banner tone="warn">{t(locale, 'bt.lc.simulated')}</Banner>}
      <p role="status">
        <strong>{dyn(locale, `bt.lc.run.${view.status}`)}</strong>
        {view.repairRound > 0 && <> · {t(locale, 'bt.lc.round', { n: view.repairRound })}</>}
      </p>
      <progress
        max={100}
        value={view.percent}
        aria-label={t(locale, 'bt.lc.progress.label')}
        aria-valuetext={`${view.percent}%`}
      />
      <p className="nz-muted">
        <Ltr>{view.percent}%</Ltr> ·{' '}
        {t(locale, 'bt.lc.summary', { done: view.done, total: view.total })}
        {view.current && (
          <>
            {' '}
            · {t(locale, 'bt.lc.current')}: {dyn(locale, `bt.lc.step.${view.current}`)}
          </>
        )}
      </p>
      <p className="nz-muted">
        {t(locale, 'bt.lc.tokens', { n: view.tokens })} ·{' '}
        {t(locale, 'bt.lc.credits', { n: view.credits })}
      </p>

      <h3 className="nz-h3">{t(locale, 'bt.lc.steps.title')}</h3>
      <ol className="nz-list">
        {view.steps.map((s) => (
          <li
            key={s.id}
            data-status={s.status}
            aria-current={view.current === s.id ? 'step' : undefined}
          >
            <span>{dyn(locale, `bt.lc.step.${s.id}`)}</span>{' '}
            <Badge {...(TONE[s.status] ? { tone: TONE[s.status]! } : {})}>
              {dyn(locale, `bt.lc.st.${s.status}`)}
            </Badge>
            {s.round > 0 && <> {t(locale, 'bt.lc.round', { n: s.round })}</>}
            {s.summary && (
              <>
                {' '}
                <bdi dir="auto" className="nz-muted">
                  {s.summary}
                </bdi>
              </>
            )}
          </li>
        ))}
      </ol>

      <h3 className="nz-h3">{t(locale, 'bt.lc.repair.title')}</h3>
      {view.repairs.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bt.lc.repair.none')}</p>
      ) : (
        <ol className="nz-list">
          {view.repairs.map((r) => (
            <li key={r.round} data-outcome={r.outcome}>
              <strong>{t(locale, 'bt.lc.repair.round', { n: r.round })}</strong> ·{' '}
              {r.classes.map((c) => dyn(locale, `bt.lc.class.${c}`)).join('، ')} ·{' '}
              {dyn(locale, `bt.lc.repair.strategy.${r.strategy}`)} ·{' '}
              <Badge
                {...(r.outcome === 'resolved'
                  ? { tone: 'success' as const }
                  : r.outcome === 'gave_up' || r.outcome === 'worse'
                    ? { tone: 'danger' as const }
                    : {})}
              >
                {dyn(locale, `bt.lc.repair.out.${r.outcome}`)}
              </Badge>
              {r.refused > 0 && <> · {t(locale, 'bt.lc.repair.refused', { n: r.refused })}</>}
            </li>
          ))}
        </ol>
      )}

      {view.evidence && (
        <div className="nz-card">
          <h3 className="nz-h3">{t(locale, 'bt.lc.evidence.title')}</h3>
          <Banner tone="warn">{dyn(locale, `bt.lc.evidence.${view.evidence.claim}`)}</Banner>
          <p>
            {t(locale, 'bt.lc.evidence.models')}:{' '}
            {view.evidence.models.length === 0 ? (
              t(locale, 'bt.lc.evidence.models.none')
            ) : (
              <Ltr>{view.evidence.models.join(', ')}</Ltr>
            )}
          </p>
          <p className="nz-muted" role="status">
            {t(
              locale,
              view.evidence.reconciled
                ? 'bt.lc.evidence.reconciled'
                : 'bt.lc.evidence.unreconciled',
            )}
          </p>
        </div>
      )}

      {view.status === 'failed' || view.failureCode
        ? view.status === 'failed' && (
            <div role="alert" className="nz-error-text">
              <strong>{t(locale, 'bt.lc.failure.title')}</strong>
              <p>
                {dyn(locale, failureKey(view.failureCode))}
                {view.failureStep && <> ({dyn(locale, `bt.lc.step.${view.failureStep}`)})</>}
              </p>
            </div>
          )
        : null}

      {view.status === 'waiting_approval' && (
        <div role="status" className="nz-card">
          <h3 className="nz-h3">{t(locale, 'bt.lc.approval.title')}</h3>
          <p>{t(locale, 'bt.lc.approval.body')}</p>
          {approvalsHref && <a href={approvalsHref}>{t(locale, 'bt.lc.approval.link')}</a>}
        </div>
      )}

      {deployment && (
        <div className="nz-card">
          <h3 className="nz-h3">{t(locale, 'bt.lc.deployment.title')}</h3>
          <dl>
            <dt>{t(locale, 'bt.lc.deployment.target')}</dt>
            <dd>{dyn(locale, `bt.lc.target.${deployment.target}`)}</dd>
            <dt>{t(locale, 'bt.lc.deployment.readiness')}</dt>
            <dd>{dyn(locale, `bt.lc.readiness.${deployment.readiness}`)}</dd>
          </dl>
          {deployment.blockers.length > 0 && (
            <>
              <p>{t(locale, 'bt.lc.deployment.blockers')}</p>
              <ul>
                {deployment.blockers.map((b) => (
                  <li key={b}>{dyn(locale, `bt.lc.blocker.${b}`)}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {versionId && view.status !== 'running' && (
        <p>
          {t(locale, 'bt.lc.result.version')}: <Ltr>{versionId}</Ltr>
        </p>
      )}

      {active && onCancel && (
        <Button variant="secondary" disabled={cancelling} onClick={onCancel}>
          {t(locale, cancelling ? 'bt.lc.cancelling' : 'bt.lc.cancel')}
        </Button>
      )}
    </section>
  );
}
