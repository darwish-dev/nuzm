'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, Field, Input, Ltr, Select } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import { newKey } from '../lib/data';
import {
  EVENT_TOPICS,
  STEP_TYPES,
  addStep,
  asDefinition,
  parseJson,
  parseJsonObject,
  removeStep,
  replaceStep,
  starterDefinition,
  validCronShape,
  validateDefinition,
  type Issue,
  type StepDef,
  type TriggerDto,
  type WorkflowDefinition,
  type WorkflowDto,
} from '../lib/m11';
import { Note } from './DataUi';
import { IssueList, SecretOnce, useM11Call } from './M11Ui';
import { WorkflowCanvas } from './WorkflowCanvas';

const TextArea = (p: React.ComponentProps<'textarea'>) => (
  <textarea className="nz-input" dir="ltr" spellCheck={false} {...p} />
);
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** One step's fields: structured for the common ones (name, links, retry, idempotency key), JSON for the parameters (and a loop body). */
function StepInspector({
  locale,
  step,
  ids,
  isStart,
  disabled,
  onChange,
  onDelete,
  onStart,
}: {
  locale: Locale;
  step: StepDef;
  ids: string[];
  isStart: boolean;
  disabled: boolean;
  onChange: (s: StepDef) => void;
  onDelete: () => void;
  onStart: () => void;
}) {
  const [idDraft, setIdDraft] = useState(step.id);
  const [paramsText, setParamsText] = useState(pretty(step.params ?? {}));
  const [bodyText, setBodyText] = useState(pretty(step.body ?? []));
  const [paramsErr, setParamsErr] = useState<string | undefined>();
  const [bodyErr, setBodyErr] = useState<string | undefined>();
  const [idErr, setIdErr] = useState<string | undefined>();
  const others = ids.filter((i) => i !== step.id);
  const link = (key: 'next' | 'onTrue' | 'onFalse', label: string) => (
    <Field id={`step-${key}`} label={label}>
      {(a) => (
        <Select
          {...a}
          disabled={disabled}
          value={step[key] ?? ''}
          onChange={(e) => onChange({ ...step, [key]: e.target.value || undefined })}
        >
          <option value="">{t(locale, 'm11.wf.insp.noLink')}</option>
          {others.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
  function commitId() {
    const v = idDraft.trim();
    if (v === step.id) return setIdErr(undefined);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(v)) return setIdErr(t(locale, 'm11.wf.insp.idInvalid'));
    if (ids.includes(v)) return setIdErr(t(locale, 'm11.wf.insp.idTaken'));
    setIdErr(undefined);
    onChange({ ...step, id: v });
  }
  return (
    <section className="nz-card" aria-label={t(locale, 'm11.wf.insp.title')}>
      <h3 className="nz-h2">
        {t(locale, 'm11.wf.insp.title')}:{' '}
        <Badge>{tDynamic(locale, `m11.wf.type.${step.type}`, step.type)}</Badge>
      </h3>
      <Field
        id="step-id"
        label={t(locale, 'm11.wf.insp.id')}
        help={t(locale, 'm11.wf.insp.idHelp')}
        error={idErr}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            disabled={disabled}
            value={idDraft}
            onChange={(e) => setIdDraft(e.target.value)}
            onBlur={commitId}
          />
        )}
      </Field>
      <Field id="step-name" label={t(locale, 'm11.wf.insp.name')}>
        {(a) => (
          <Input
            {...a}
            disabled={disabled}
            value={step.name ?? ''}
            onChange={(e) => onChange({ ...step, name: e.target.value || undefined })}
          />
        )}
      </Field>
      {step.type === 'condition' ? (
        <>
          {link('onTrue', t(locale, 'm11.wf.insp.onTrue'))}
          {link('onFalse', t(locale, 'm11.wf.insp.onFalse'))}
        </>
      ) : (
        link('next', t(locale, 'm11.wf.insp.next'))
      )}
      <Field
        id="step-retry"
        label={t(locale, 'm11.wf.insp.retry')}
        help={t(locale, 'm11.wf.insp.retryHelp')}
      >
        {(a) => (
          <Input
            {...a}
            dir="ltr"
            type="number"
            min={1}
            max={10}
            disabled={disabled}
            value={step.retry?.maxAttempts ?? ''}
            onChange={(e) =>
              onChange({
                ...step,
                retry: e.target.value === '' ? undefined : { maxAttempts: Number(e.target.value) },
              })
            }
          />
        )}
      </Field>
      {step.type === 'http_request' && (
        <Field
          id="step-idem"
          label={t(locale, 'm11.wf.insp.idem')}
          help={t(locale, 'm11.wf.insp.idemHelp')}
        >
          {(a) => (
            <Input
              {...a}
              dir="ltr"
              disabled={disabled}
              value={step.idempotencyKey ?? ''}
              onChange={(e) => onChange({ ...step, idempotencyKey: e.target.value || undefined })}
            />
          )}
        </Field>
      )}
      <Field
        id="step-params"
        label={t(locale, 'm11.wf.insp.params')}
        help={t(locale, 'm11.wf.insp.paramsHelp')}
        error={paramsErr}
      >
        {(a) => (
          <TextArea
            {...a}
            rows={8}
            disabled={disabled}
            value={paramsText}
            onChange={(e) => {
              setParamsText(e.target.value);
              const r = parseJsonObject(e.target.value);
              if (!r.ok)
                return setParamsErr(t(locale, 'm11.wf.json.invalid', { message: r.message }));
              setParamsErr(undefined);
              onChange({ ...step, params: r.value });
            }}
          />
        )}
      </Field>
      {step.type === 'loop' && (
        <Field
          id="step-body"
          label={t(locale, 'm11.wf.insp.body')}
          help={t(locale, 'm11.wf.insp.bodyHelp')}
          error={bodyErr}
        >
          {(a) => (
            <TextArea
              {...a}
              rows={8}
              disabled={disabled}
              value={bodyText}
              onChange={(e) => {
                setBodyText(e.target.value);
                const r = parseJson(e.target.value);
                if (!r.ok)
                  return setBodyErr(t(locale, 'm11.wf.json.invalid', { message: r.message }));
                if (!Array.isArray(r.value)) return setBodyErr(t(locale, 'm11.wf.insp.bodyArray'));
                setBodyErr(undefined);
                onChange({ ...step, body: r.value as StepDef[] });
              }}
            />
          )}
        </Field>
      )}
      <div className="nz-row">
        <Button variant="secondary" disabled={disabled || isStart} onClick={onStart}>
          {t(locale, 'm11.wf.insp.setStart')}
        </Button>
        <Button variant="danger" disabled={disabled} onClick={onDelete}>
          {t(locale, 'm11.wf.insp.delete')}
        </Button>
      </div>
    </section>
  );
}

/**
 * UI-M11-02: the workflow editor (canvas + JSON view). Used for a NEW workflow (`mode: 'create'`: name, triggers, definition → POST /v1/workflows, the webhook secret is shown once) and for
 * a new VERSION of an existing one (`mode: 'edit'`: POST /v1/workflows/{id}/versions, the server's 422 `errors[]` shown inline). The browser checks the structure as you type (hints only); the
 * server's answer is the authority and is shown unchanged. An agency acting for a client passes `actingOrgId`.
 */
export function WorkflowEditor({
  locale,
  mode,
  workflow,
  actingOrgId,
  canWrite,
  mfaFactorId,
}: {
  locale: Locale;
  mode: 'create' | 'edit';
  workflow?: WorkflowDto;
  actingOrgId?: string;
  canWrite: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const call = useM11Call(locale, mfaFactorId);
  const [defText, setDefText] = useState(pretty(workflow?.definition ?? starterDefinition()));
  const [view, setView] = useState<'canvas' | 'json'>('canvas');
  const [selected, setSelected] = useState<string | null>(null);
  const [addType, setAddType] = useState<string>('http_request');
  const [name, setName] = useState('');
  const [nameErr, setNameErr] = useState<string | undefined>();
  const [notes, setNotes] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [trig, setTrig] = useState({
    manual: true,
    webhook: false,
    schedule: false,
    event: false,
    cron: '0 * * * *',
    timezone: 'UTC',
    topic: EVENT_TOPICS[0] as string,
  });
  const [trigErr, setTrigErr] = useState<string | undefined>();
  const [created, setCreated] = useState<WorkflowDto | null>(null);

  const parsed = useMemo(() => parseJson(defText), [defText]);
  const def = parsed.ok ? asDefinition(parsed.value) : null;
  const hints = useMemo<{ errors: Issue[]; warnings: Issue[] }>(
    () =>
      parsed.ok
        ? validateDefinition(parsed.value)
        : { errors: [{ code: 'json', path: '$', message: parsed.message }], warnings: [] },
    [parsed],
  );
  const update = (d: WorkflowDefinition) => setDefText(pretty(d));
  const step = def?.steps.find((s) => s.id === selected) ?? null;
  const readOnly = !canWrite;

  function triggers(): TriggerDto[] | null {
    const out: TriggerDto[] = [];
    if (trig.manual) out.push({ type: 'manual' });
    if (trig.webhook) out.push({ type: 'webhook' });
    if (trig.schedule) {
      if (!validCronShape(trig.cron)) {
        setTrigErr(t(locale, 'm11.wf.new.errCron'));
        return null;
      }
      out.push({
        type: 'schedule',
        cron: trig.cron.trim(),
        timezone: trig.timezone.trim() || 'UTC',
      });
    }
    if (trig.event) out.push({ type: 'platform_event', topic: trig.topic });
    if (out.length === 0) {
      setTrigErr(t(locale, 'm11.wf.new.errTriggers'));
      return null;
    }
    setTrigErr(undefined);
    return out;
  }

  function publish() {
    if (!parsed.ok) return;
    const acting = actingOrgId;
    if (mode === 'create') {
      if (name.trim() === '') return setNameErr(t(locale, 'm11.wf.new.errName'));
      setNameErr(undefined);
      const list = triggers();
      if (!list) return;
      const key = newKey();
      void call.run(
        () =>
          browserApi().POST('/v1/workflows', {
            params: { header: { 'Idempotency-Key': key, 'X-Nuzm-Acting-Org': acting } },
            body: { name: name.trim(), definition: parsed.value, triggers: list },
          }),
        (w) => {
          const dto = w as unknown as WorkflowDto;
          if (dto.webhook) return setCreated(dto);
          router.push(`/automation/workflows/${dto.id}/edit`);
        },
      );
      return;
    }
    const key = newKey();
    void call.run(
      () =>
        browserApi().POST('/v1/workflows/{id}/versions', {
          params: {
            path: { id: workflow!.id },
            header: { 'Idempotency-Key': key, 'X-Nuzm-Acting-Org': acting },
          },
          body: { definition: parsed.value, ...(notes.trim() ? { notes: notes.trim() } : {}) },
        }),
      (v) => {
        const x = v as unknown as { version: number; unchanged: boolean };
        setDone(
          t(locale, x.unchanged ? 'm11.wf.publish.unchanged' : 'm11.wf.publish.done', {
            version: x.version,
          }),
        );
        router.refresh();
      },
    );
  }

  if (created?.webhook)
    return (
      <>
        <Banner tone="warn">{t(locale, 'm11.wf.new.created', { name: created.name })}</Banner>
        <SecretOnce
          locale={locale}
          label={t(locale, 'm11.wf.hook.title')}
          value={created.webhook.secret}
          extra={
            <>
              <p>{t(locale, 'm11.wf.hook.body')}</p>
              <p>
                {t(locale, 'm11.wf.hook.url')}:{' '}
                <Ltr>{`${typeof window === 'undefined' ? '' : window.location.origin}${created.webhook.path}`}</Ltr>
              </p>
            </>
          }
          onDone={() => {
            const id = created.id;
            setCreated(null);
            router.push(`/automation/workflows/${id}/edit`);
          }}
        />
      </>
    );

  return (
    <div>
      {mode === 'create' && (
        <section
          className="nz-card"
          aria-label={t(locale, 'm11.wf.new.title')}
          style={{ marginBlockEnd: 16 }}
        >
          <h2 className="nz-h2">{t(locale, 'm11.wf.new.title')}</h2>
          <Field id="wf-name" label={t(locale, 'field.name')} error={nameErr}>
            {(a) => (
              <Input
                {...a}
                maxLength={120}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <fieldset>
            <legend>{t(locale, 'm11.wf.new.triggers')}</legend>
            <p className="nz-help">{t(locale, 'm11.wf.new.triggersHelp')}</p>
            {(['manual', 'webhook', 'schedule', 'event'] as const).map((k) => (
              <label key={k} className="nz-row">
                <input
                  type="checkbox"
                  checked={trig[k]}
                  onChange={() => setTrig((x) => ({ ...x, [k]: !x[k] }))}
                />
                {t(locale, `m11.wf.trigger.${k}`)}
              </label>
            ))}
            {trig.schedule && (
              <div className="nz-row">
                <Field
                  id="wf-cron"
                  label={t(locale, 'm11.wf.new.cron')}
                  help={t(locale, 'm11.wf.new.cronHelp')}
                >
                  {(a) => (
                    <Input
                      {...a}
                      dir="ltr"
                      value={trig.cron}
                      onChange={(e) => setTrig((x) => ({ ...x, cron: e.target.value }))}
                    />
                  )}
                </Field>
                <Field id="wf-tz" label={t(locale, 'm11.wf.new.timezone')}>
                  {(a) => (
                    <Input
                      {...a}
                      dir="ltr"
                      value={trig.timezone}
                      onChange={(e) => setTrig((x) => ({ ...x, timezone: e.target.value }))}
                    />
                  )}
                </Field>
              </div>
            )}
            {trig.event && (
              <Field id="wf-topic" label={t(locale, 'm11.wf.new.topic')}>
                {(a) => (
                  <Select
                    {...a}
                    value={trig.topic}
                    onChange={(e) => setTrig((x) => ({ ...x, topic: e.target.value }))}
                  >
                    {EVENT_TOPICS.map((tp) => (
                      <option key={tp} value={tp}>
                        {tp}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            {trigErr && (
              <p role="alert" className="nz-error-text">
                {trigErr}
              </p>
            )}
          </fieldset>
        </section>
      )}
      {mode === 'edit' && workflow && (
        <p className="nz-muted">
          {t(locale, 'm11.wf.edit.triggers')}:{' '}
          {workflow.triggers.map((x, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {tDynamic(
                locale,
                `m11.wf.trigger.${x.type === 'platform_event' ? 'event' : x.type}`,
                x.type,
              )}
              {x.cron ? (
                <Ltr>{` (${x.cron} ${x.timezone ?? 'UTC'})`}</Ltr>
              ) : x.topic ? (
                <Ltr>{` (${x.topic})`}</Ltr>
              ) : null}
            </span>
          ))}{' '}
          {t(locale, 'm11.wf.edit.triggersFixed')}
        </p>
      )}

      <div
        className="nz-row"
        role="group"
        aria-label={t(locale, 'm11.wf.view.label')}
        style={{ marginBlockEnd: 12 }}
      >
        <Button
          variant={view === 'canvas' ? 'primary' : 'secondary'}
          aria-pressed={view === 'canvas'}
          onClick={() => setView('canvas')}
        >
          {t(locale, 'm11.wf.view.canvas')}
        </Button>
        <Button
          variant={view === 'json' ? 'primary' : 'secondary'}
          aria-pressed={view === 'json'}
          onClick={() => setView('json')}
        >
          {t(locale, 'm11.wf.view.json')}
        </Button>
        {view === 'canvas' && (
          <>
            <Select
              aria-label={t(locale, 'm11.wf.add.type')}
              value={addType}
              disabled={readOnly || !def}
              onChange={(e) => setAddType(e.target.value)}
            >
              {STEP_TYPES.map((x) => (
                <option key={x} value={x}>
                  {tDynamic(locale, `m11.wf.type.${x}`, x)}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              disabled={readOnly || !def}
              onClick={() => {
                if (!def) return;
                const r = addStep(def, addType, selected ?? undefined);
                update(r.def);
                setSelected(r.id);
              }}
            >
              {t(locale, 'm11.wf.add.action')}
            </Button>
          </>
        )}
      </div>

      {view === 'json' || !def ? (
        <>
          {!def && view === 'canvas' && (
            <p role="alert" className="nz-error-text">
              {t(locale, 'm11.wf.canvas.badJson')}
            </p>
          )}
          <Field
            id="wf-json"
            label={t(locale, 'm11.wf.json.label')}
            help={t(locale, 'm11.wf.json.help')}
            error={
              parsed.ok ? undefined : t(locale, 'm11.wf.json.invalid', { message: parsed.message })
            }
          >
            {(a) => (
              <TextArea
                {...a}
                rows={22}
                readOnly={readOnly}
                value={defText}
                onChange={(e) => setDefText(e.target.value)}
              />
            )}
          </Field>
        </>
      ) : (
        <div className="nz-grid" style={{ alignItems: 'start' }}>
          <WorkflowCanvas locale={locale} def={def} selected={selected} onSelect={setSelected} />
          {step ? (
            <StepInspector
              key={step.id}
              locale={locale}
              step={step}
              ids={def.steps.map((s) => s.id)}
              isStart={def.start === step.id}
              disabled={readOnly}
              onChange={(next) => {
                update(replaceStep(def, step.id, next));
                if (next.id !== step.id) setSelected(next.id);
              }}
              onDelete={() => {
                update(removeStep(def, step.id));
                setSelected(null);
              }}
              onStart={() => update({ ...def, start: step.id })}
            />
          ) : (
            <p className="nz-muted">{t(locale, 'm11.wf.insp.pick')}</p>
          )}
        </div>
      )}

      <section aria-label={t(locale, 'm11.wf.hints.title')} style={{ marginBlockStart: 16 }}>
        <h3 className="nz-h2">{t(locale, 'm11.wf.hints.title')}</h3>
        <p className="nz-muted">{t(locale, 'm11.wf.hints.help')}</p>
        {hints.errors.length === 0 && hints.warnings.length === 0 ? (
          <p role="status">{t(locale, 'm11.wf.hints.ok')}</p>
        ) : (
          <div role="status">
            <ul>
              {hints.errors.map((i, n) => (
                <li key={`e${n}`} className="nz-error-text">
                  <Badge tone="danger">{t(locale, 'm11.wf.hints.error')}</Badge> <Ltr>{i.path}</Ltr>{' '}
                  {i.message}
                </li>
              ))}
              {hints.warnings.map((i, n) => (
                <li key={`w${n}`}>
                  <Badge tone="warn">{t(locale, 'm11.wf.hints.warning')}</Badge> <Ltr>{i.path}</Ltr>{' '}
                  {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {canWrite && (
        <section
          aria-label={t(locale, mode === 'create' ? 'm11.wf.new.publish' : 'm11.wf.publish.title')}
          style={{ marginBlockStart: 16 }}
        >
          {mode === 'edit' && (
            <Field id="wf-notes" label={t(locale, 'm11.wf.publish.notes')}>
              {(a) => (
                <Input
                  {...a}
                  maxLength={2000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              )}
            </Field>
          )}
          <Button disabled={call.busy || !parsed.ok} onClick={publish}>
            {t(locale, mode === 'create' ? 'm11.wf.new.publish' : 'm11.wf.publish.action')}
          </Button>
          <Note n={call.notice} />
          <IssueList locale={locale} issues={call.issues} />
          {call.panel}
          {done && (
            <p role="status" style={{ color: 'inherit' }}>
              {done}
            </p>
          )}
        </section>
      )}
      {!canWrite && <p className="nz-muted">{t(locale, 'm11.wf.readOnly')}</p>}
    </div>
  );
}
