'use client';
import { useRef, useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale, type MessageKey } from '@nuzm/i18n';
import {
  Badge,
  Banner,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  Input,
  Ltr,
  Select,
} from '@nuzm/ui';
import { problemOf } from '../lib/builder';
import { bapi, newKey } from '../lib/builder-client';
import {
  executionOf,
  generationProblemKey,
  pct,
  planBody,
  reasonKey,
  statusKey,
  type ContextPreview,
  type Plan,
  type Workspace,
} from '../lib/generation';
import { MODES, type AdaptationMode } from '../lib/templates';
import { AgentTimeline } from './AgentTimeline';

/**
 * The template workspace (S-K6): the project compared with the template copy it started from, the plan, the EXACT context a model would receive (nothing is sent before the person
 * starts the run) and the adaptation run. Never shows a template's own files: the comparison lists the customer's own paths only.
 */
export function TemplateWorkspace({
  locale,
  projectId,
  workspace,
  canWrite,
  canRun,
  agentic = false,
}: {
  locale: Locale;
  projectId: string;
  workspace: Workspace;
  /** `builder:write` */
  canWrite: boolean;
  /** `ai:write` */
  canRun: boolean;
  /** `knowledge.agentic_generation` is on for the organization (default off) */
  agentic?: boolean;
}) {
  return (
    <div className="knd">
      <div className="knd-head">
        <div>
          <h1 className="nz-h1">{t(locale, 'gen.title')}</h1>
          <p className="nz-muted">{t(locale, 'gen.intro')}</p>
        </div>
        <ButtonLink variant="secondary" href={`/${locale}/builder/projects/${projectId}`}>
          {t(locale, 'gen.back')}
        </ButtonLink>
      </div>
      {!workspace.linked ? (
        <EmptyState
          title={t(locale, 'gen.notLinked.title')}
          body={t(locale, 'gen.notLinked.body')}
        />
      ) : (
        <>
          <Facts locale={locale} w={workspace} />
          <DiffCard locale={locale} w={workspace} />
          <PlanCard
            locale={locale}
            projectId={projectId}
            canWrite={canWrite}
            canRun={canRun}
            agentic={agentic}
          />
        </>
      )}
    </div>
  );
}

function Facts({ locale, w }: { locale: Locale; w: Workspace }) {
  return (
    <Card aria-labelledby="gen-tpl-h">
      <h2 className="nz-h2" id="gen-tpl-h">
        {t(locale, 'gen.template.title')}
      </h2>
      {w.template ? (
        <p>
          <strong>{w.template.name}</strong>{' '}
          <Badge>{t(locale, 'tpl.detail.version', { n: w.template.versionSeq ?? 1 })}</Badge>{' '}
          <Ltr>{w.template.license ?? ''}</Ltr>
        </p>
      ) : (
        <p className="nz-muted" role="status">
          {t(locale, 'gen.template.gone')}
        </p>
      )}
      {w.copiedAt && (
        <p className="nz-muted">
          {t(locale, 'gen.template.copied', {
            date: new Date(w.copiedAt).toISOString().slice(0, 10),
          })}
        </p>
      )}
    </Card>
  );
}

function PathList({ title, paths }: { title: string; paths: string[] }) {
  if (paths.length === 0) return null;
  return (
    <details>
      <summary>{title}</summary>
      <ul className="kni-list">
        {paths.map((p) => (
          <li key={p}>
            <Ltr>{p}</Ltr>
          </li>
        ))}
      </ul>
    </details>
  );
}

function DiffCard({ locale, w }: { locale: Locale; w: Workspace }) {
  const d = w.diff;
  if (!d) return null;
  const c = {
    added: d.counts?.added ?? 0,
    modified: d.counts?.modified ?? 0,
    removed: d.counts?.removed ?? 0,
  };
  const same = c.added + c.modified + c.removed === 0;
  return (
    <Card aria-labelledby="gen-diff-h" data-testid="gen-diff">
      <h2 className="nz-h2" id="gen-diff-h">
        {t(locale, 'gen.diff.title')}
      </h2>
      <p>
        <progress
          className="kr-bar"
          max={100}
          value={pct(d.departure)}
          aria-label={t(locale, 'gen.diff.departure', { n: pct(d.departure) })}
        />{' '}
        {t(locale, 'gen.diff.departure', { n: pct(d.departure) })}
      </p>
      {same ? (
        <p className="nz-muted">{t(locale, 'gen.diff.none')}</p>
      ) : (
        <>
          <PathList
            title={t(locale, 'gen.diff.added', { n: c.added ?? 0 })}
            paths={d.added ?? []}
          />
          <PathList
            title={t(locale, 'gen.diff.modified', { n: c.modified ?? 0 })}
            paths={d.modified ?? []}
          />
          <PathList
            title={t(locale, 'gen.diff.removed', { n: c.removed ?? 0 })}
            paths={d.removed ?? []}
          />
        </>
      )}
      <p className="nz-muted">{t(locale, 'gen.diff.unchanged', { n: d.unchanged ?? 0 })}</p>
      {d.truncated && <p className="nz-muted">{t(locale, 'gen.diff.truncated')}</p>}
    </Card>
  );
}

function PlanCard({
  locale,
  projectId,
  canWrite,
  canRun,
  agentic,
}: {
  locale: Locale;
  projectId: string;
  canWrite: boolean;
  canRun: boolean;
  agentic: boolean;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AdaptationMode>('ADAPTIVE');
  const [useAgent, setUseAgent] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [ctx, setCtx] = useState<ContextPreview | null>(null);
  const [busy, setBusy] = useState<'plan' | 'ctx' | 'run' | 'refresh' | null>(null);
  const [error, setError] = useState<{ key: MessageKey; trace?: string } | null>(null);
  const planKey = useRef(newKey());
  const runKey = useRef(newKey());

  const fail = (r: Parameters<typeof problemOf>[0]) => {
    const p = problemOf(r);
    setError({ key: generationProblemKey(p), trace: p.traceId });
  };

  async function create(e: FormEvent) {
    e.preventDefault();
    const body = planBody({ projectId, text, mode });
    if (!body || busy) return;
    setBusy('plan');
    setError(null);
    const r = await bapi.post<Plan>('/v1/builder/generation-plans', {
      body,
      idempotencyKey: planKey.current,
    });
    setBusy(null);
    if (!r.response.ok || !r.data) return fail(r);
    setPlan(r.data);
    setCtx(null);
    runKey.current = newKey();
  }
  async function preview() {
    if (!plan?.id || busy) return;
    setBusy('ctx');
    setError(null);
    const r = await bapi.get<ContextPreview>(`/v1/builder/generation-plans/${plan.id}/context`);
    setBusy(null);
    if (!r.response.ok || !r.data) return fail(r);
    setCtx(r.data);
  }
  async function start() {
    if (!plan?.id || busy) return;
    setBusy('run');
    setError(null);
    const r = await bapi.post<Plan>(`/v1/builder/generation-plans/${plan.id}/runs`, {
      body: agentic && useAgent ? { agentic: true } : {},
      idempotencyKey: runKey.current,
    });
    setBusy(null);
    if (!r.response.ok || !r.data) {
      if (r.response.status !== 599) runKey.current = newKey(); // a definitive refusal frees the key; an uncertain failure keeps it
      return fail(r);
    }
    setPlan(r.data);
  }
  async function refresh() {
    if (!plan?.id || busy) return;
    setBusy('refresh');
    const r = await bapi.get<Plan>(`/v1/builder/generation-plans/${plan.id}`);
    setBusy(null);
    if (r.response.ok && r.data) setPlan(r.data);
  }

  const ex = executionOf(plan);
  return (
    <>
      <Card aria-labelledby="gen-plan-h">
        <h2 className="nz-h2" id="gen-plan-h">
          {t(locale, 'gen.plan.title')}
        </h2>
        <p className="nz-muted">{t(locale, 'gen.plan.help')}</p>
        {!canWrite ? (
          <p className="nz-muted" role="status">
            {t(locale, 'gen.readonly')}
          </p>
        ) : (
          !plan && (
            <form onSubmit={create} className="knd" aria-busy={busy === 'plan'}>
              <Field
                id="gen-text"
                label={t(locale, 'gen.plan.text')}
                help={t(locale, 'tpl.rec.text.help')}
              >
                {(a) => (
                  <Input
                    {...a}
                    value={text}
                    maxLength={2000}
                    onChange={(e) => {
                      setText(e.target.value);
                      planKey.current = newKey();
                    }}
                  />
                )}
              </Field>
              <Field
                id="gen-mode"
                label={t(locale, 'tpl.start.mode')}
                help={t(locale, `tpl.start.mode.help.${mode}` as MessageKey)}
              >
                {(a) => (
                  <Select
                    {...a}
                    value={mode}
                    onChange={(e) => {
                      setMode(e.target.value as AdaptationMode);
                      planKey.current = newKey();
                    }}
                  >
                    {MODES.map((m) => (
                      <option key={m} value={m}>
                        {t(locale, `kr.mode.${m}` as MessageKey)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div>
                <Button type="submit" disabled={busy !== null || text.trim().length === 0}>
                  {busy === 'plan' ? t(locale, 'gen.plan.busy') : t(locale, 'gen.plan.create')}
                </Button>
              </div>
            </form>
          )
        )}
        {error && (
          <Banner tone="danger">
            <span role="alert">
              {t(locale, error.key)}
              {error.trace && (
                <>
                  {' '}
                  <Ltr>{error.trace}</Ltr>
                </>
              )}
            </span>
          </Banner>
        )}
        {plan && (
          <div data-testid="gen-plan" className="knd">
            <p>
              {t(locale, 'gen.plan.created')} <Badge>{t(locale, statusKey(plan.status))}</Badge>
            </p>
            {agentic && ex.status === 'READY' && canRun && !ex.runId && (
              <p>
                <label>
                  <input
                    type="checkbox"
                    checked={useAgent}
                    onChange={(e) => setUseAgent(e.target.checked)}
                    disabled={busy !== null}
                    aria-describedby="gen-agent-help"
                  />{' '}
                  {t(locale, 'agt.opt.label')}
                </label>
                <span className="nz-muted" id="gen-agent-help">
                  {' '}
                  {t(locale, 'agt.opt.help')}
                </span>
              </p>
            )}
            <div className="kni-toolbar">
              <Button variant="secondary" onClick={preview} disabled={busy !== null}>
                {busy === 'ctx' ? t(locale, 'gen.ctx.busy') : t(locale, 'gen.ctx.preview')}
              </Button>
              {ex.status === 'READY' && canRun && (
                <Button onClick={start} disabled={busy !== null}>
                  {busy === 'run' ? t(locale, 'gen.run.busy') : t(locale, 'gen.run.start')}
                </Button>
              )}
              {ex.runId && (
                <>
                  <ButtonLink variant="secondary" href={`/${locale}/builder/runs/${ex.runId}`}>
                    {t(locale, 'gen.run.open')}
                  </ButtonLink>
                  <Button variant="secondary" onClick={refresh} disabled={busy !== null}>
                    {t(locale, 'gen.run.refresh')}
                  </Button>
                </>
              )}
            </div>
            {ex.status === 'READY' && !canRun && (
              <p className="nz-muted">{t(locale, 'gen.run.needsAi')}</p>
            )}
            {ex.status === 'BLOCKED' && (
              <p className="nz-muted" role="status">
                {t(locale, 'gen.run.blocked')}
              </p>
            )}
            {ex.status === 'READY' && <p className="nz-muted">{t(locale, 'gen.run.disclaimer')}</p>}
          </div>
        )}
        {ctx && <ContextCard locale={locale} c={ctx} />}
      </Card>
      {plan?.id && ex.runId && <AgentTimeline locale={locale} planId={plan.id} />}
    </>
  );
}

function ContextCard({ locale, c }: { locale: Locale; c: ContextPreview }) {
  const used = c.tokens?.used ?? 0;
  const budget = c.tokens?.budget ?? 0;
  return (
    <section aria-labelledby="gen-ctx-h" data-testid="gen-ctx" className="knd">
      <h3 className="nz-h3" id="gen-ctx-h">
        {t(locale, 'gen.ctx.title')}
      </h3>
      <p className="nz-muted">{t(locale, 'gen.ctx.intro')}</p>
      <p>
        <progress
          className="kr-bar"
          max={budget || 1}
          value={Math.min(used, budget || 1)}
          aria-label={t(locale, 'gen.ctx.tokens', { used, budget })}
        />{' '}
        {t(locale, 'gen.ctx.tokens', { used, budget })}
      </p>
      {(c.notes ?? []).includes('template_contents_withheld') && (
        <p role="status">{t(locale, 'gen.ctx.withheld')}</p>
      )}
      <details>
        <summary>{t(locale, 'gen.ctx.policy')}</summary>
        <p>{c.policy}</p>
      </details>
      {(c.blocks ?? []).map((b, i) => (
        <details key={`${b.label}-${i}`}>
          <summary>
            {tDynamic(locale, `gen.ctx.block.${b.kind}`, b.kind ?? '')}{' '}
            <Ltr>{`${b.tokens} ${t(locale, 'gen.ctx.tokenUnit')}`}</Ltr>
          </summary>
          <pre className="kni-log" dir="ltr">
            {b.text}
          </pre>
        </details>
      ))}
      {(c.excluded ?? []).length > 0 && (
        <>
          <h4 className="nz-h3">{t(locale, 'gen.ctx.excluded')}</h4>
          <ul className="kni-list">
            {(c.excluded ?? []).slice(0, 100).map((x) => (
              <li key={x.path}>
                <Ltr>{x.path}</Ltr> — {t(locale, reasonKey(x.reason))}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
