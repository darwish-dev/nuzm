'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import {
  ORG_CAPS,
  budgetBody,
  budgetForm,
  budgetsIfMatch,
  projectsWithoutCap,
  type BudgetDocDto,
  type BudgetError,
  type BudgetForm,
  type OrgCap,
  type ProjectCapDto,
} from '../lib/ai';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

const ERROR_KEY = {
  cap: 'aiu.budgets.err.cap',
  thresholds: 'aiu.budgets.err.thresholds',
  retention: 'aiu.budgets.err.retention',
  projectCap: 'aiu.budgets.err.projectCap',
} as const satisfies Record<BudgetError, string>;

const CAP_LABEL = {
  dailyCredits: 'aiu.budgets.dailyCredits',
  runMaxCredits: 'aiu.budgets.runMaxCredits',
  runMaxTokens: 'aiu.budgets.runMaxTokens',
  totalCredits: 'aiu.budgets.totalCredits',
  totalTokens: 'aiu.budgets.totalTokens',
} as const satisfies Record<OrgCap, string>;

/**
 * UI-M09-11: organization and project caps, alert thresholds, the prompt-body logging switch and the auto-apply switch. Saving sends the budget
 * version as If-Match: a stale version (412) asks the member to reload instead of overwriting someone else's change. Members without
 * `ai:budgets:write` see the same values read-only; enabling auto-apply needs `ai:write` too (the API answers 403 otherwise).
 */
export function AiBudgetsForm(p: {
  locale: Locale;
  org: BudgetDocDto;
  projects: ProjectCapDto[];
  version: number;
  /** The organization's projects (for names and for adding a cap); empty when the member may not list projects. */
  projectOptions: { id: string; name: string }[];
  canWrite: boolean;
  canAutoApply: boolean;
}) {
  const { locale } = p;
  const router = useRouter();
  const a = useAction(locale, null);
  const [f, setF] = useState<BudgetForm>(() => budgetForm(p.org, p.projects));
  const [err, setErr] = useState<BudgetError | null>(null);
  const [stale, setStale] = useState(false);
  const [add, setAdd] = useState('');
  // a new budget version from the server (after a save or a reload) replaces the form's values; the notice and the other hooks stay
  const [seen, setSeen] = useState(p.version);
  if (p.version !== seen) {
    setSeen(p.version);
    setF(budgetForm(p.org, p.projects));
    setStale(false);
    setErr(null);
  }
  const ro = !p.canWrite;
  const nameOf = (id: string) => p.projectOptions.find((o) => o.id === id)?.name;
  const free = projectsWithoutCap(p.projectOptions, f.projects);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (ro) return;
    const r = budgetBody(f);
    setErr(r.error ?? null);
    if (!r.body) return;
    const body = r.body;
    setStale(false);
    void a.run(
      async () => {
        const res = await browserApi().PUT('/v1/ai/budgets', {
          params: { header: { 'If-Match': budgetsIfMatch(p.version) } },
          body,
        });
        if (res.response.status === 412) setStale(true);
        return res;
      },
      () => {
        a.setNotice({ tone: 'ok', text: t(locale, 'aiu.budgets.saved') });
        router.refresh();
      },
      {
        403: t(locale, 'aiu.budgets.forbidden'),
        412: t(locale, 'aiu.budgets.stale'),
        422: t(locale, 'aiu.budgets.refused'),
        428: t(locale, 'aiu.budgets.stale'),
      },
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-label={t(locale, 'aiu.budgets.title')}>
      {ro && <Banner tone="warn">{t(locale, 'aiu.budgets.readOnly')}</Banner>}
      {stale && (
        <Banner tone="danger">
          {t(locale, 'aiu.budgets.stale')}{' '}
          <Button variant="secondary" onClick={() => router.refresh()}>
            {t(locale, 'aiu.budgets.reload')}
          </Button>
        </Banner>
      )}

      <section className="nz-card" aria-labelledby="aiu-caps-h">
        <h2 id="aiu-caps-h" className="nz-h2">
          {t(locale, 'aiu.budgets.orgCaps')}
        </h2>
        <p className="nz-muted">{t(locale, 'aiu.budgets.capHelp')}</p>
        <div className="nz-grid">
          {ORG_CAPS.map((k) => (
            <Field key={k} id={`aiu-${k}`} label={t(locale, CAP_LABEL[k])}>
              {(x) => (
                <Input
                  {...x}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={t(locale, 'aiu.budgets.noCap')}
                  value={f.caps[k]}
                  disabled={ro}
                  onChange={(e) => setF({ ...f, caps: { ...f.caps, [k]: e.target.value } })}
                />
              )}
            </Field>
          ))}
        </div>
        <Field
          id="aiu-thresholds"
          label={t(locale, 'aiu.budgets.thresholds')}
          help={t(locale, 'aiu.budgets.thresholdsHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              autoComplete="off"
              value={f.thresholds}
              disabled={ro}
              onChange={(e) => setF({ ...f, thresholds: e.target.value })}
            />
          )}
        </Field>
      </section>

      <section className="nz-card" aria-labelledby="aiu-proj-h" style={{ marginBlockStart: 16 }}>
        <h2 id="aiu-proj-h" className="nz-h2">
          {t(locale, 'aiu.budgets.projectCaps')}
        </h2>
        <p className="nz-muted">{t(locale, 'aiu.budgets.projectHelp')}</p>
        {f.projects.length === 0 ? (
          <p>{t(locale, 'aiu.budgets.noProjectCaps')}</p>
        ) : (
          f.projects.map((row, i) => (
            <fieldset key={row.projectId} className="nz-card" style={{ marginBlockEnd: 8 }}>
              <legend>{nameOf(row.projectId) ?? <Ltr>{row.projectId}</Ltr>}</legend>
              <div className="nz-grid">
                <Field id={`aiu-pc-${i}`} label={t(locale, 'aiu.budgets.totalCredits')}>
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      inputMode="numeric"
                      placeholder={t(locale, 'aiu.budgets.noCap')}
                      value={row.totalCredits}
                      disabled={ro}
                      onChange={(e) =>
                        setF({
                          ...f,
                          projects: f.projects.map((r, j) =>
                            j === i ? { ...r, totalCredits: e.target.value } : r,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
                <Field id={`aiu-pt-${i}`} label={t(locale, 'aiu.budgets.totalTokens')}>
                  {(x) => (
                    <Input
                      {...x}
                      dir="ltr"
                      inputMode="numeric"
                      placeholder={t(locale, 'aiu.budgets.noCap')}
                      value={row.totalTokens}
                      disabled={ro}
                      onChange={(e) =>
                        setF({
                          ...f,
                          projects: f.projects.map((r, j) =>
                            j === i ? { ...r, totalTokens: e.target.value } : r,
                          ),
                        })
                      }
                    />
                  )}
                </Field>
              </div>
            </fieldset>
          ))
        )}
        {!ro && free.length > 0 && (
          <div className="nz-row">
            <Field id="aiu-add" label={t(locale, 'aiu.budgets.addProject')}>
              {(x) => (
                <Select {...x} value={add} onChange={(e) => setAdd(e.target.value)}>
                  <option value="">{t(locale, 'aiu.budgets.chooseProject')}</option>
                  {free.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              variant="secondary"
              disabled={add === ''}
              onClick={() => {
                setF({
                  ...f,
                  projects: [...f.projects, { projectId: add, totalCredits: '', totalTokens: '' }],
                });
                setAdd('');
              }}
            >
              {t(locale, 'aiu.budgets.addCap')}
            </Button>
          </div>
        )}
      </section>

      <section className="nz-card" aria-labelledby="aiu-log-h" style={{ marginBlockStart: 16 }}>
        <h2 id="aiu-log-h" className="nz-h2">
          {t(locale, 'aiu.budgets.logTitle')}
        </h2>
        <p>{t(locale, 'aiu.budgets.logExplain')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minBlockSize: 44 }}>
          <input
            type="checkbox"
            checked={f.logBodies}
            disabled={ro}
            onChange={(e) => setF({ ...f, logBodies: e.target.checked })}
          />
          {t(locale, 'aiu.budgets.logToggle')}
        </label>
        <Field
          id="aiu-retention"
          label={t(locale, 'aiu.budgets.retention')}
          help={t(locale, 'aiu.budgets.retentionHelp')}
        >
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              value={f.retentionDays}
              disabled={ro || !f.logBodies}
              onChange={(e) => setF({ ...f, retentionDays: e.target.value })}
            />
          )}
        </Field>
      </section>

      <section className="nz-card" aria-labelledby="aiu-auto-h" style={{ marginBlockStart: 16 }}>
        <h2 id="aiu-auto-h" className="nz-h2">
          {t(locale, 'aiu.budgets.autoTitle')}
        </h2>
        <p>{t(locale, 'aiu.budgets.autoExplain')}</p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minBlockSize: 44 }}>
          <input
            type="checkbox"
            checked={f.autoApply}
            disabled={ro || (!p.canAutoApply && !f.autoApply)}
            aria-describedby="aiu-auto-help"
            onChange={(e) => setF({ ...f, autoApply: e.target.checked })}
          />
          {t(locale, 'aiu.budgets.autoToggle')}
        </label>
        <p id="aiu-auto-help" className="nz-muted">
          {p.canAutoApply ? t(locale, 'aiu.budgets.autoOff') : t(locale, 'aiu.budgets.autoRoles')}
        </p>
      </section>

      {err && (
        <p role="alert" className="nz-error-text">
          {t(locale, ERROR_KEY[err])}
        </p>
      )}
      <NoticeText notice={stale ? null : a.notice} />
      {a.panel}
      {!ro && (
        <div className="nz-row" style={{ marginBlockStart: 16 }}>
          <Button type="submit" disabled={a.busy}>
            {t(locale, 'action.save')}
          </Button>
        </div>
      )}
    </form>
  );
}
