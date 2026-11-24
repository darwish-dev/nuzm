'use client';
import { useId, useState, type FormEvent } from 'react';
import { formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { ConfirmDialog } from './DataUi';

/**
 * Builder tools (S-05 priority 6): change preview with per-file diffs and an approval gate, rollback controls, the implementation plan with task progress, the review findings, the
 * build/repair timeline and the project memory. These are PRESENTATIONAL: the page that hosts them calls the API (CONTRACT-1/2, behind `builder_tools.enabled`) and passes the data
 * in, so every state (loading, empty, error, forbidden) is explicit and testable. Code and paths are always shown left-to-right inside the Arabic layout; no colour carries meaning
 * alone (a diff line starts with + or −, a finding has a text severity); every control is a native element, reachable and operable by keyboard.
 */

// ───────────────────────── data shapes (the API's JSON) ─────────────────────────
export type PanelState = 'loading' | 'ready' | 'error' | 'forbidden';
export interface PreviewFileView {
  op: 'add' | 'modify' | 'delete' | 'rename';
  path: string;
  from?: string;
  added: number;
  removed: number;
  diff: string;
  diffTruncated: boolean;
}
export interface PreviewView {
  ok: boolean;
  errors: { at: string; code: string; message: string }[];
  files: PreviewFileView[];
  totals: { files: number; added: number; removed: number };
  risks: { code: string; message: string }[];
  approval: { required: boolean; reasons: string[] };
  drift?: number;
}
export interface Bilingual {
  en: string;
  ar: string;
}
export interface PlanTaskView {
  id: string;
  title: Bilingual;
  kind: string;
  dependsOn: string[];
  wave: number;
  files: string[];
  acceptance: Bilingual[];
  approval: string | null;
}
export interface PlanView {
  productType: string;
  stack: { title: Bilingual; parts: string[]; reason: 'requested' | 'default' };
  tasks: PlanTaskView[];
  waves: number;
  fileCount: number;
  approvals: { taskId: string; reason: string }[];
  risks: { code: string; text: Bilingual }[];
  analysis: { questions: { id: string; text: Bilingual }[]; ambiguities: { id: string; text: Bilingual }[]; notes: Bilingual[]; confidence: number };
}
export interface EstimateView {
  totalTokens: number;
  costMinor: number;
}
export type TaskProgress = 'pending' | 'running' | 'done' | 'failed';
export interface FindingView {
  severity: 'error' | 'warning' | 'info';
  code: string;
  path: string | null;
  line: number | null;
  message: string;
}
export interface RepairIterationView {
  n: number;
  phase: 'static' | 'typecheck' | 'unit-tests' | 'build';
  failed: boolean;
  findings: number;
  opsApplied: number;
  diagnostics: { kind: string; path: string | null; line: number | null; code: string | null; message: string }[];
}
export interface RepairReportView {
  status: 'passed' | 'failed' | 'stopped';
  reason: string;
  iterations: RepairIterationView[];
  totalOps: number;
  builds: number;
  pendingApproval: number;
  origin: 'MOCK' | 'REAL';
}
export interface MemoryEntryView {
  id: string;
  kind: 'decision' | 'convention' | 'preference' | 'fact' | 'issue';
  text: string;
  source: 'user' | 'agent' | 'review';
  pinned: boolean;
}

const MEMORY_KINDS = ['decision', 'convention', 'preference', 'fact', 'issue'] as const;
const sevTone = (s: FindingView['severity']) => (s === 'error' ? 'danger' : s === 'warning' ? 'warn' : undefined);
const biText = (b: Bilingual, locale: Locale) => b[locale];

function StateNote({ locale, state, children }: { locale: Locale; state: PanelState; children?: never }) {
  void children;
  if (state === 'loading')
    return (
      <p role="status" className="nz-muted">
        {t(locale, 'bt.state.loading')}
      </p>
    );
  if (state === 'forbidden') return <Banner tone="warn">{t(locale, 'bt.state.forbidden')}</Banner>;
  if (state === 'error')
    return (
      <div role="alert" className="nz-error-text">
        {t(locale, 'bt.state.error')}
      </div>
    );
  return null;
}

// ───────────────────────── change preview ─────────────────────────
/** A unified diff as text: each line keeps its own marker (+, −, space, @@), shown left-to-right and never as markup. */
export function DiffText({ locale, diff, label }: { locale: Locale; diff: string; label: string }) {
  if (!diff) return <p className="nz-muted">{t(locale, 'bt.preview.nodiff')}</p>;
  return (
    <pre dir="ltr" lang="en" aria-label={label} className="bt-diff" style={{ overflowX: 'auto', margin: 0, padding: 8, background: 'var(--nuzm-color-surface)', border: '1px solid var(--nuzm-color-border)', borderRadius: 'var(--nuzm-radius-sm)' }}>
      {diff.split('\n').map((line, i) => {
        const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+++') || line.startsWith('---') ? 'meta' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
        return (
          <span
            key={i}
            data-kind={kind}
            style={{
              display: 'block',
              background: kind === 'add' ? '#ecfdf3' : kind === 'del' ? '#fef3f2' : undefined,
              color: kind === 'hunk' ? 'var(--nuzm-color-muted)' : undefined,
              fontWeight: kind === 'meta' ? 600 : undefined,
            }}
          >
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

export function ChangePreviewPanel({
  locale,
  state,
  preview,
  onApply,
  onCancel,
  busy = false,
  applyKey = 'bt.preview.apply',
}: {
  locale: Locale;
  state: PanelState;
  preview?: PreviewView;
  /** called with `confirmed`: true only after the person ticked the confirmation the approval rule asks for */
  onApply?: (confirmed: boolean) => void;
  onCancel?: () => void;
  busy?: boolean;
  applyKey?: 'bt.preview.apply' | 'bt.roll.go';
}) {
  const id = useId();
  const [selected, setSelected] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  if (state !== 'ready' || !preview)
    return (
      <section aria-labelledby={`${id}-h`}>
        <h3 className="nz-h2" id={`${id}-h`}>
          {t(locale, 'bt.preview.title')}
        </h3>
        <StateNote locale={locale} state={state === 'ready' ? 'error' : state} />
      </section>
    );
  const file = preview.files[Math.min(selected, Math.max(0, preview.files.length - 1))];
  const needsConfirm = preview.approval.required;
  const canApply = preview.ok && preview.files.length > 0 && (!needsConfirm || confirmed) && !busy;
  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 className="nz-h2" id={`${id}-h`}>
        {t(locale, 'bt.preview.title')}
      </h3>
      {!preview.ok && (
        <div role="alert" className="nz-error-text">
          <strong>{t(locale, 'bt.preview.errors')}</strong>
          <ul>
            {preview.errors.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <Ltr>{e.at}</Ltr> {tDynamic(locale, `bt.err.${e.code}`, e.message)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.ok && preview.files.length === 0 && <p className="nz-muted">{t(locale, 'bt.preview.none')}</p>}
      {preview.files.length > 0 && (
        <>
          <p aria-live="polite">{t(locale, 'bt.preview.totals', { files: preview.totals.files, added: preview.totals.added, removed: preview.totals.removed })}</p>
          <div className="nz-row" style={{ alignItems: 'flex-start' }}>
            <ul className="bld-list" aria-label={t(locale, 'bt.preview.files')} style={{ minInlineSize: 220 }}>
              {preview.files.map((f, i) => (
                <li key={`${f.op}-${f.path}`}>
                  <button type="button" className="nz-btn" data-variant={i === selected ? 'primary' : 'secondary'} aria-pressed={i === selected} aria-controls={`${id}-diff`} onClick={() => setSelected(i)}>
                    <Badge tone={f.op === 'delete' ? 'danger' : f.op === 'add' ? 'success' : undefined}>{t(locale, `bt.preview.op.${f.op}`)}</Badge>{' '}
                    <Ltr>{f.path}</Ltr>
                    <span className="nz-muted">
                      {' '}
                      +{f.added} −{f.removed}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div id={`${id}-diff`} style={{ flex: 1, minInlineSize: 0 }}>
              {file && (
                <>
                  {file.from && (
                    <p className="nz-muted">
                      <Ltr>{file.from}</Ltr> → <Ltr>{file.path}</Ltr>
                    </p>
                  )}
                  <DiffText locale={locale} diff={file.diff} label={t(locale, 'bt.preview.diffOf', { path: file.path })} />
                  {file.diffTruncated && <p className="nz-muted">{t(locale, 'bt.preview.truncated')}</p>}
                </>
              )}
            </div>
          </div>
        </>
      )}
      {(preview.drift ?? 0) > 0 && <p className="nz-muted">{t(locale, 'bt.preview.drift', { n: preview.drift! })}</p>}
      {preview.risks.length > 0 && (
        <div>
          <h4 className="nz-h2">{t(locale, 'bt.preview.risks')}</h4>
          <ul className="bld-list">
            {preview.risks.map((r) => (
              <li key={r.code}>
                <Badge tone="warn">{tDynamic(locale, `bt.risk.${r.code}`, r.message)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {needsConfirm && (
        <Banner tone="warn">
          <label>
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {t(locale, 'bt.preview.confirm')}
          </label>
        </Banner>
      )}
      {(onApply || onCancel) && (
        <div className="nz-row">
          {onApply && (
            <Button type="button" disabled={!canApply} onClick={() => onApply(confirmed)}>
              {t(locale, applyKey)}
            </Button>
          )}
          {onCancel && (
            <Button type="button" variant="secondary" onClick={onCancel}>
              {t(locale, 'bt.preview.cancel')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ───────────────────────── rollback controls ─────────────────────────
export interface VersionOption {
  id: string;
  label: string;
  isHead: boolean;
}
/** Pick an older version, see exactly what the rollback would change, confirm, apply. The rollback becomes a NEW head version: history is never rewritten. */
export function RollbackControls({
  locale,
  versions,
  previewState,
  preview,
  onPick,
  onRollback,
  busy = false,
  done = false,
}: {
  locale: Locale;
  versions: VersionOption[];
  previewState: PanelState;
  preview?: PreviewView;
  /** the host loads the diff head → target and passes it back */
  onPick: (versionId: string) => void;
  onRollback: (versionId: string, confirmed: boolean) => void;
  busy?: boolean;
  done?: boolean;
}) {
  const older = versions.filter((v) => !v.isHead);
  const [target, setTarget] = useState('');
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  if (older.length === 0) return <p className="nz-muted">{t(locale, 'bt.roll.none')}</p>;
  const go = (e: FormEvent) => {
    e.preventDefault();
    if (target) onPick(target);
  };
  return (
    <section aria-labelledby="bt-roll-h">
      <h3 className="nz-h2" id="bt-roll-h">
        {t(locale, 'bt.roll.title')}
      </h3>
      <form onSubmit={go} className="nz-row">
        <Field id="bt-roll-target" label={t(locale, 'bt.roll.pick')}>
          {(x) => (
            <Select {...x} value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">—</option>
              {older.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" variant="secondary" disabled={!target || busy}>
          {t(locale, 'bt.roll.preview')}
        </Button>
      </form>
      {done && (
        <p role="status" aria-live="polite">
          {t(locale, 'bt.roll.done')}
        </p>
      )}
      {target && (
        <ChangePreviewPanel
          locale={locale}
          state={previewState}
          {...(preview ? { preview } : {})}
          busy={busy}
          applyKey="bt.roll.go"
          onApply={(c) => {
            setConfirmed(c);
            setOpen(true);
          }}
        />
      )}
      <ConfirmDialog open={open} title={t(locale, 'bt.roll.confirmTitle')} onClose={() => setOpen(false)}>
        <p>{t(locale, 'bt.roll.confirmBody')}</p>
        <div className="nz-row">
          <Button
            type="button"
            onClick={() => {
              setOpen(false);
              onRollback(target, confirmed);
            }}
          >
            {t(locale, 'bt.roll.go')}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            {t(locale, 'bt.preview.cancel')}
          </Button>
        </div>
      </ConfirmDialog>
    </section>
  );
}

// ───────────────────────── plan and task progress ─────────────────────────
export function PlanPanel({
  locale,
  state,
  plan,
  estimate,
  progress = {},
}: {
  locale: Locale;
  state: PanelState;
  plan?: PlanView;
  estimate?: EstimateView;
  progress?: Record<string, TaskProgress>;
}) {
  if (state !== 'ready' || !plan)
    return (
      <section aria-labelledby="bt-plan-h">
        <h3 className="nz-h2" id="bt-plan-h">
          {t(locale, 'bt.plan.title')}
        </h3>
        <StateNote locale={locale} state={state === 'ready' ? 'error' : state} />
      </section>
    );
  const waves = Array.from({ length: plan.waves }, (_, w) => plan.tasks.filter((x) => x.wave === w)).filter((w) => w.length > 0);
  const done = plan.tasks.filter((x) => progress[x.id] === 'done').length;
  return (
    <section aria-labelledby="bt-plan-h">
      <h3 className="nz-h2" id="bt-plan-h">
        {t(locale, 'bt.plan.title')}
      </h3>
      <p>
        <Badge>{tDynamic(locale, `bt.product.${plan.productType}`, plan.productType)}</Badge> {t(locale, 'bt.plan.stack')}: <bdi dir="ltr">{biText(plan.stack.title, locale)}</bdi>{' '}
        <span className="nz-muted">({t(locale, plan.stack.reason === 'requested' ? 'bt.plan.stack.requested' : 'bt.plan.stack.default')})</span>
      </p>
      <p className="nz-muted">
        {t(locale, 'bt.plan.summary', { tasks: plan.tasks.length, waves: plan.waves, files: plan.fileCount })} · {t(locale, 'bt.plan.confidence', { pct: Math.round(plan.analysis.confidence * 100) })}
      </p>
      {estimate && (
        <p>
          {t(locale, 'bt.plan.estimate', { tokens: estimate.totalTokens.toLocaleString(locale === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB'), cost: formatMinor(String(estimate.costMinor), 'SAR', locale) })}{' '}
          <span className="nz-muted">{t(locale, 'bt.plan.estimate.note')}</span>
        </p>
      )}
      {Object.keys(progress).length > 0 && (
        <p role="status" aria-live="polite">
          {t(locale, 'bt.plan.progress', { done, total: plan.tasks.length })}
        </p>
      )}
      {plan.analysis.ambiguities.length > 0 && (
        <Banner tone="warn">
          <ul>
            {plan.analysis.ambiguities.map((a) => (
              <li key={a.id}>{biText(a.text, locale)}</li>
            ))}
          </ul>
        </Banner>
      )}
      <ol aria-label={t(locale, 'bt.plan.waves')} className="bld-list">
        {waves.map((tasks) => (
          <li key={tasks[0]!.wave}>
            <h4 className="nz-h2">{t(locale, 'bt.plan.wave', { n: tasks[0]!.wave + 1 })}</h4>
            <ul className="bld-list">
              {tasks.map((task) => {
                const st = progress[task.id] ?? 'pending';
                return (
                  <li key={task.id} data-task={task.id}>
                    <Ltr>{task.id}</Ltr> <strong>{biText(task.title, locale)}</strong> <Badge>{tDynamic(locale, `bt.kind.${task.kind}`, task.kind)}</Badge>{' '}
                    {Object.keys(progress).length > 0 && <Badge tone={st === 'done' ? 'success' : st === 'failed' ? 'danger' : undefined}>{t(locale, `bt.task.state.${st}`)}</Badge>}{' '}
                    {task.approval && <Badge tone="warn">{t(locale, 'bt.task.needsApproval')}</Badge>}
                    <ul>
                      {task.acceptance.map((a, i) => (
                        <li key={i} className="nz-muted">
                          {biText(a, locale)}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      {plan.approvals.length > 0 && (
        <div>
          <h4 className="nz-h2">{t(locale, 'bt.plan.approvals')}</h4>
          <ul className="bld-list">
            {plan.approvals.map((a) => (
              <li key={a.taskId}>
                <Ltr>{a.taskId}</Ltr> {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {plan.analysis.notes.length > 0 && (
        <div>
          <h4 className="nz-h2">{t(locale, 'bt.plan.notes')}</h4>
          <ul className="bld-list">
            {plan.analysis.notes.map((n, i) => (
              <li key={i}>{biText(n, locale)}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.analysis.questions.length > 0 && (
        <div>
          <h4 className="nz-h2">{t(locale, 'bt.plan.questions')}</h4>
          <ul className="bld-list">
            {plan.analysis.questions.map((q) => (
              <li key={q.id}>{biText(q.text, locale)}</li>
            ))}
          </ul>
        </div>
      )}
      {plan.risks.length > 0 && (
        <div>
          <h4 className="nz-h2">{t(locale, 'bt.plan.risks')}</h4>
          <ul className="bld-list">
            {plan.risks.map((r) => (
              <li key={r.code}>
                <Badge tone="warn">{biText(r.text, locale)}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// ───────────────────────── review findings ─────────────────────────
export function ReviewPanel({ locale, state, findings = [], summary }: { locale: Locale; state: PanelState; findings?: FindingView[]; summary?: { passed: boolean; errors: number; warnings: number } }) {
  if (state !== 'ready')
    return (
      <section aria-labelledby="bt-rev-h">
        <h3 className="nz-h2" id="bt-rev-h">
          {t(locale, 'bt.review.title')}
        </h3>
        <StateNote locale={locale} state={state} />
      </section>
    );
  return (
    <section aria-labelledby="bt-rev-h">
      <h3 className="nz-h2" id="bt-rev-h">
        {t(locale, 'bt.review.title')}
      </h3>
      {summary && (
        <p role="status" aria-live="polite">
          <Badge tone={summary.passed ? 'success' : 'danger'}>{summary.passed ? t(locale, 'bt.review.passed') : t(locale, 'bt.review.failed', { errors: summary.errors, warnings: summary.warnings })}</Badge>
        </p>
      )}
      {findings.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bt.review.none')}</p>
      ) : (
        <ul className="bld-list">
          {findings.map((f, i) => (
            <li key={`${f.code}-${f.path}-${f.line}-${i}`}>
              <Badge tone={sevTone(f.severity)}>{t(locale, `bt.sev.${f.severity}`)}</Badge> {tDynamic(locale, `bt.finding.${f.code}`, f.message)}
              {f.path && (
                <span className="nz-muted">
                  {' '}
                  <Ltr>{f.line ? `${f.path}:${f.line}` : f.path}</Ltr>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ───────────────────────── build and repair timeline ─────────────────────────
export function RepairTimeline({ locale, report }: { locale: Locale; report: RepairReportView }) {
  return (
    <section aria-labelledby="bt-build-h">
      <h3 className="nz-h2" id="bt-build-h">
        {t(locale, 'bt.build.title')}
      </h3>
      {report.origin === 'MOCK' && <Banner tone="warn">{t(locale, 'bt.build.simulated')}</Banner>}
      <p role="status" aria-live="polite">
        <Badge tone={report.status === 'passed' ? 'success' : report.status === 'failed' ? 'danger' : 'warn'}>{t(locale, `bt.build.status.${report.status}`)}</Badge>{' '}
        {tDynamic(locale, `bt.build.reason.${report.reason}`, report.reason)} · {t(locale, 'bt.build.totals', { builds: report.builds, ops: report.totalOps })}
      </p>
      {report.pendingApproval > 0 && <Banner tone="warn">{t(locale, 'bt.build.pending', { n: report.pendingApproval })}</Banner>}
      <ol className="bld-list" aria-label={t(locale, 'bt.build.title')}>
        {report.iterations.map((it) => (
          <li key={it.n}>
            <strong>{t(locale, 'bt.build.iteration', { n: it.n })}</strong> <Badge>{t(locale, `bt.build.phase.${it.phase}`)}</Badge>{' '}
            <Badge tone={it.failed ? 'danger' : 'success'}>{it.failed ? t(locale, 'bt.build.failed') : t(locale, 'bt.build.ok')}</Badge>
            {it.opsApplied > 0 && <span className="nz-muted"> {t(locale, 'bt.build.ops', { n: it.opsApplied })}</span>}
            {it.diagnostics.length > 0 && (
              <ul>
                {it.diagnostics.map((d, i) => (
                  <li key={i} className="nz-muted">
                    {d.path && <Ltr>{d.line ? `${d.path}:${d.line}` : d.path}</Ltr>} {d.code && <Ltr>{d.code}</Ltr>} <bdi dir="auto">{d.message}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ───────────────────────── project memory ─────────────────────────
export function MemoryPanel({
  locale,
  state,
  entries = [],
  onAdd,
  onForget,
  busy = false,
  canWrite = true,
}: {
  locale: Locale;
  state: PanelState;
  entries?: MemoryEntryView[];
  onAdd?: (e: { kind: MemoryEntryView['kind']; text: string; pinned: boolean }) => void;
  onForget?: (id: string) => void;
  busy?: boolean;
  canWrite?: boolean;
}) {
  const [kind, setKind] = useState<MemoryEntryView['kind']>('decision');
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !onAdd) return;
    onAdd({ kind, text: text.trim(), pinned });
    setText('');
  };
  return (
    <section aria-labelledby="bt-mem-h">
      <h3 className="nz-h2" id="bt-mem-h">
        {t(locale, 'bt.mem.title')}
      </h3>
      <p className="nz-muted">{t(locale, 'bt.mem.help')}</p>
      {state !== 'ready' ? (
        <StateNote locale={locale} state={state} />
      ) : entries.length === 0 ? (
        <p className="nz-muted">{t(locale, 'bt.mem.empty')}</p>
      ) : (
        <ul className="bld-list">
          {entries.map((e) => (
            <li key={e.id}>
              <Badge>{t(locale, `bt.mem.kind.${e.kind}`)}</Badge> {e.pinned && <Badge tone="warn">{t(locale, 'bt.mem.pinned')}</Badge>} <bdi dir="auto">{e.text}</bdi>{' '}
              <span className="nz-muted">({t(locale, `bt.mem.source.${e.source}`)})</span>
              {canWrite && onForget && (
                <Button type="button" variant="secondary" disabled={busy} onClick={() => onForget(e.id)} aria-label={t(locale, 'bt.mem.forgetNote', { text: e.text.slice(0, 40) })}>
                  {t(locale, 'bt.mem.forget')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && onAdd && state === 'ready' && (
        <form onSubmit={submit} className="nz-row">
          <Field id="bt-mem-kind" label={t(locale, 'bt.mem.kind')}>
            {(x) => (
              <Select {...x} value={kind} onChange={(e) => setKind(e.target.value as MemoryEntryView['kind'])}>
                {MEMORY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(locale, `bt.mem.kind.${k}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="bt-mem-text" label={t(locale, 'bt.mem.text')}>
            {(x) => <Input {...x} value={text} maxLength={400} onChange={(e) => setText(e.target.value)} />}
          </Field>
          <label>
            <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> {t(locale, 'bt.mem.pinned')}
          </label>
          <Button type="submit" disabled={busy || !text.trim()}>
            {t(locale, 'bt.mem.add')}
          </Button>
        </form>
      )}
    </section>
  );
}
