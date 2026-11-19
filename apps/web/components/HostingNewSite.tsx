'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Field, Input, Select } from '@nuzm/ui';
import { errorText } from '../lib/actions';
import { browserApi } from '../lib/client';
import { NoticeText } from './Feedback';

export interface NewSitePlan {
  id: string;
  name: string;
  runtimes: string[];
  /** e.g. "10 GB disk · 100 GB bandwidth · 5 databases"; text only, from the plan's own quotas. */
  summary: string;
  /** The plan's price as text, or null when it is quoted at checkout. */
  price: string | null;
}

const key = () => crypto.randomUUID();
const code = (r: { error?: unknown }) => (r.error as { code?: string } | undefined)?.code;

/** Add a website: name, project, plan and runtime → a hosting quote → the site (UI-M06-02). Errors say what to change. */
export function HostingNewSite({
  locale,
  plans,
  projects,
  defaultDomain = '',
  initialPlanId,
}: {
  locale: Locale;
  plans: NewSitePlan[];
  projects: { id: string; name: string }[];
  /** Pre-filled when the form is opened from a domain ("create a website on this domain"). */
  defaultDomain?: string;
  /** The plan chosen on the plans page, when it is one of `plans`. */
  initialPlanId?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [planId, setPlanId] = useState(
    plans.some((p) => p.id === initialPlanId) ? (initialPlanId as string) : (plans[0]?.id ?? ''),
  );
  const plan = plans.find((p) => p.id === planId);
  const [runtime, setRuntime] = useState(plan?.runtimes[0] ?? '');
  const [domain, setDomain] = useState(defaultDomain);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);

  const pickPlan = (id: string) => {
    setPlanId(id);
    const p = plans.find((x) => x.id === id);
    if (p && !p.runtimes.includes(runtime)) setRuntime(p.runtimes[0] ?? '');
  };
  const fail = (status: number, c: string | undefined) =>
    setN({
      tone: 'error',
      text:
        c === 'no_capacity'
          ? t(locale, 'host.new.noCapacity')
          : c === 'quota_exceeded'
            ? t(locale, 'host.new.quota')
            : c === 'unsupported_runtime'
              ? t(locale, 'host.new.runtimeBad')
              : errorText(locale, status, c),
    });

  async function go(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !projectId || !planId || !runtime)
      return setN({ tone: 'error', text: t(locale, 'err.validation') });
    setBusy(true);
    setN(null);
    const q = await browserApi().POST('/v1/quotes', {
      params: { header: { 'Idempotency-Key': key() } },
      body: { kind: 'hosting', items: [{ planId, runtime }] } as never,
    });
    if (!q.response.ok) {
      setBusy(false);
      return fail(q.response.status, code(q));
    }
    const r = await browserApi().POST('/v1/hosting/sites', {
      params: { header: { 'Idempotency-Key': key() } },
      body: {
        quoteId: (q.data as { id: string }).id,
        planId,
        name: name.trim(),
        projectId,
        runtime,
        ...(domain.trim() ? { primaryDomain: domain.trim().toLowerCase() } : {}),
      },
    });
    setBusy(false);
    if (!r.response.ok || !r.data) return fail(r.response.status, code(r));
    router.push(`/${locale}/hosting/sites/${r.data.site.id}`);
  }

  return (
    <form onSubmit={go} noValidate aria-label={t(locale, 'host.new.title')}>
      <div className="nzc-form-part">
        <h3>{t(locale, 'host.new.plan')}</h3>
        <div className="nzc-plans" role="radiogroup" aria-label={t(locale, 'host.new.plan')}>
          {plans.map((p) => (
            <label key={p.id} className="nzc-plan">
              <span className="nzc-plan-head">
                <span className="nzc-plan-name">{p.name}</span>
                <input
                  type="radio"
                  name="plan"
                  value={p.id}
                  checked={p.id === planId}
                  onChange={() => pickPlan(p.id)}
                />
              </span>
              <span className="nzc-plan-sum">{p.summary}</span>
              {p.price && <span className="nzc-plan-price">{p.price}</span>}
            </label>
          ))}
        </div>
      </div>
      <div className="nzc-form-part">
        <h3>{t(locale, 'host.new.title')}</h3>
        <div className="nzc-form-grid">
          <Field id="ns-name" label={t(locale, 'host.new.name')}>
            {(x) => (
              <Input {...x} value={name} maxLength={63} onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
          <Field id="ns-project" label={t(locale, 'host.new.project')}>
            {(x) => (
              <Select {...x} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="ns-runtime" label={t(locale, 'host.new.runtime')}>
            {(x) => (
              <Select {...x} dir="ltr" value={runtime} onChange={(e) => setRuntime(e.target.value)}>
                {(plan?.runtimes ?? []).map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="ns-domain" label={t(locale, 'host.new.domain')}>
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                placeholder="example.com"
                autoComplete="off"
                spellCheck={false}
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
              />
            )}
          </Field>
        </div>
      </div>
      <div className="nzc-form-foot">
        <NoticeText notice={n} />
        <Button type="submit" disabled={busy || !name.trim()}>
          {t(locale, 'host.new.go')}
        </Button>
      </div>
    </form>
  );
}
