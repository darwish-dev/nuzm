'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Banner, Button, EmptyState, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { browserApi } from '../lib/client';
import {
  REGION_GROUPS,
  RULE_ACTIONS,
  RULE_MODES,
  emptyRule,
  formatCost,
  isUuid,
  loose,
  matchingRules,
  newKey,
  parseCountries,
  ruleToForm,
  sortRules,
  splitOffers,
  toRuleBody,
  type AdminOfferDto,
  type RoutingRuleDto,
  type RuleForm,
  type SimRequest,
} from '../lib/providers';
import { ProviderResult, useProviderAction } from './ProviderBits';

type RuleErrKey = 'ruleKey' | 'priority' | 'countries' | 'actionType' | 'accountId' | 'target';
const ruleTarget = (r: RoutingRuleDto) =>
  [r.action.providerKey, r.action.providerRegionId, r.action.accountId?.slice(0, 8)]
    .filter(Boolean)
    .join(' / ');
const ruleMatch = (r: RoutingRuleDto, locale: Locale) =>
  [
    r.match.mode && tDynamic(locale, `m05.adm.rt.mode.${r.match.mode}`, r.match.mode),
    r.match.country?.length && r.match.country.join(', '),
    r.match.geoGroup?.length &&
      r.match.geoGroup.map((g) => tDynamic(locale, `m05.adm.group.${g}`, g)).join(', '),
  ]
    .filter(Boolean)
    .join(' · ') || t(locale, 'm05.adm.rt.matchAll');

/** Rules in evaluation order (priority ascending). Each row can start a new version of its rule (rows are immutable server side). */
export function RulesTable(p: {
  locale: Locale;
  rules: RoutingRuleDto[];
  canManage: boolean;
  onEdit?: (r: RoutingRuleDto) => void;
}) {
  if (p.rules.length === 0)
    return (
      <EmptyState
        title={t(p.locale, 'm05.adm.rt.empty.title')}
        body={t(p.locale, 'm05.adm.rt.empty.body')}
      />
    );
  return (
    <Table
      caption={t(p.locale, 'm05.adm.rt.rules')}
      rows={sortRules(p.rules)}
      rowKey={(r) => r.id}
      columns={[
        {
          key: 'pr',
          header: t(p.locale, 'm05.adm.rt.priority'),
          render: (r) => <Ltr>{String(r.priority)}</Ltr>,
        },
        {
          key: 'k',
          header: t(p.locale, 'm05.adm.rt.ruleKey'),
          render: (r) => (
            <span>
              <Ltr>{r.ruleKey}</Ltr> <span className="nz-muted">v{r.version}</span>
            </span>
          ),
        },
        {
          key: 'm',
          header: t(p.locale, 'm05.adm.rt.match'),
          render: (r) => ruleMatch(r, p.locale),
        },
        {
          key: 'a',
          header: t(p.locale, 'm05.adm.rt.action'),
          render: (r) => (
            <span>
              <Badge tone={r.action.type === 'exclude' ? 'warn' : undefined}>
                {tDynamic(p.locale, `m05.adm.rt.action.${r.action.type}`, r.action.type ?? '—')}
              </Badge>{' '}
              <Ltr>{ruleTarget(r)}</Ltr>
            </span>
          ),
        },
        {
          key: 'e',
          header: t(p.locale, 'm05.adm.col.status'),
          render: (r) => (
            <Badge tone={r.enabled ? undefined : 'warn'}>
              {t(p.locale, r.enabled ? 'm05.adm.rt.enabled' : 'm05.adm.rt.disabled')}
            </Badge>
          ),
        },
        ...(p.canManage && p.onEdit
          ? [
              {
                key: 'x',
                header: t(p.locale, 'field.action'),
                render: (r: RoutingRuleDto) => (
                  <Button
                    variant="secondary"
                    aria-label={t(p.locale, 'm05.adm.rt.editFor', { key: r.ruleKey })}
                    onClick={() => p.onEdit?.(r)}
                  >
                    {t(p.locale, 'm05.adm.rt.edit')}
                  </Button>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}

/** Create a rule or save a new version of one (the server keeps every version; the change is audited as routing.rule.changed). */
export function RuleEditor(p: {
  locale: Locale;
  mfaFactorId: string | null;
  initial: RuleForm;
  editing: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const a = useProviderAction(p.locale, p.mfaFactorId);
  const [f, setF] = useState<RuleForm>(p.initial);
  const [errs, setErrs] = useState<string[]>([]);
  const [idem, setIdem] = useState(newKey());
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const bad = (k: RuleErrKey) =>
    errs.includes(k) ? t(p.locale, `m05.adm.rt.err.${k}`) : undefined;
  function submit(e: FormEvent) {
    e.preventDefault();
    const r = toRuleBody(f);
    if ('invalid' in r) return setErrs(r.invalid);
    setErrs([]);
    void a.run(
      () =>
        loose(browserApi()).POST('/v1/admin/routing-rules', {
          headers: { 'Idempotency-Key': idem },
          body: r.body,
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'm05.adm.rt.saved') });
        setIdem(newKey());
        router.refresh();
        p.onDone();
      },
      a.overrides,
    );
  }
  return (
    <form
      onSubmit={submit}
      className="nz-card"
      aria-label={t(p.locale, p.editing ? 'm05.adm.rt.editRule' : 'm05.adm.rt.newRule')}
      noValidate
    >
      <h2 className="nz-h2">
        {t(p.locale, p.editing ? 'm05.adm.rt.editRule' : 'm05.adm.rt.newRule')}
      </h2>
      <p className="nz-muted">{t(p.locale, 'm05.adm.rt.versionHelp')}</p>
      <Field id="rt-key" label={t(p.locale, 'm05.adm.rt.ruleKey')} error={bad('ruleKey')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            readOnly={p.editing}
            value={f.ruleKey}
            onChange={(e) => set('ruleKey', e.target.value)}
          />
        )}
      </Field>
      <Field id="rt-prio" label={t(p.locale, 'm05.adm.rt.priority')} error={bad('priority')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={f.priority}
            onChange={(e) => set('priority', e.target.value)}
          />
        )}
      </Field>
      <Field
        id="rt-countries"
        label={t(p.locale, 'm05.adm.rt.countries')}
        help={t(p.locale, 'm05.adm.rt.countries.help')}
        error={bad('countries')}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.countries}
            onChange={(e) => set('countries', e.target.value)}
          />
        )}
      </Field>
      <fieldset>
        <legend>{t(p.locale, 'm05.adm.rt.groups')}</legend>
        {REGION_GROUPS.map((g) => (
          <label key={g} className="nz-row">
            <input
              type="checkbox"
              checked={f.geoGroups.includes(g)}
              onChange={(e) =>
                set(
                  'geoGroups',
                  e.target.checked ? [...f.geoGroups, g] : f.geoGroups.filter((x) => x !== g),
                )
              }
            />
            {t(p.locale, `m05.adm.group.${g}`)}
          </label>
        ))}
      </fieldset>
      <Field id="rt-mode" label={t(p.locale, 'm05.adm.rt.modeLabel')}>
        {(x) => (
          <Select {...x} value={f.mode} onChange={(e) => set('mode', e.target.value)}>
            <option value="">{t(p.locale, 'm05.adm.rt.modeAny')}</option>
            {RULE_MODES.map((m) => (
              <option key={m} value={m}>
                {t(p.locale, `m05.adm.rt.mode.${m}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field id="rt-action" label={t(p.locale, 'm05.adm.rt.action')} error={bad('actionType')}>
        {(x) => (
          <Select {...x} value={f.actionType} onChange={(e) => set('actionType', e.target.value)}>
            {RULE_ACTIONS.map((m) => (
              <option key={m} value={m}>
                {t(p.locale, `m05.adm.rt.action.${m}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <p className="nz-muted" id="rt-target-help">
        {t(p.locale, 'm05.adm.rt.targetHelp')}
      </p>
      {bad('target') && (
        <p role="alert" className="nz-error-text">
          {bad('target')}
        </p>
      )}
      <Field id="rt-provider" label={t(p.locale, 'm05.adm.rt.providerKey')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.providerKey}
            onChange={(e) => set('providerKey', e.target.value)}
          />
        )}
      </Field>
      <Field id="rt-region" label={t(p.locale, 'm05.adm.rt.providerRegionId')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.providerRegionId}
            onChange={(e) => set('providerRegionId', e.target.value)}
          />
        )}
      </Field>
      <Field id="rt-account" label={t(p.locale, 'm05.adm.rt.accountId')} error={bad('accountId')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            value={f.accountId}
            onChange={(e) => set('accountId', e.target.value)}
          />
        )}
      </Field>
      <Field id="rt-note" label={t(p.locale, 'm05.adm.rt.note')}>
        {(x) => (
          <Input
            {...x}
            maxLength={500}
            value={f.note}
            onChange={(e) => set('note', e.target.value)}
          />
        )}
      </Field>
      <label className="nz-row">
        <input
          type="checkbox"
          checked={f.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        {t(p.locale, 'm05.adm.rt.enabled')}
      </label>
      <span className="nz-row">
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'action.save')}
        </Button>
        {p.editing && (
          <Button variant="secondary" onClick={p.onDone}>
            {t(p.locale, 'action.cancel')}
          </Button>
        )}
      </span>
      <ProviderResult n={a.notice} problem={a.problem} locale={p.locale} />
      {a.panel}
    </form>
  );
}

interface OfferPage {
  items: AdminOfferDto[];
  nextCursor: string | null;
}

/**
 * Dry-run simulator. READ-ONLY: it asks the admin offers endpoint how one organization's request would be evaluated (eligible offers and,
 * for the others, the failing conditions) and lists the rules whose match fits. It creates nothing and changes no rule.
 */
export function RoutingSimulator(p: { locale: Locale; rules: RoutingRuleDto[] }) {
  const a = useProviderAction(p.locale, null);
  const [orgId, setOrgId] = useState('');
  const [mode, setMode] = useState<'automatic' | 'explicit'>('automatic');
  const [country, setCountry] = useState('');
  const [group, setGroup] = useState('');
  const [err, setErr] = useState('');
  const [out, setOut] = useState<{ offers: AdminOfferDto[]; req: SimRequest } | null>(null);
  function run(e: FormEvent) {
    e.preventDefault();
    const c = country.trim() === '' ? [] : parseCountries(country);
    if (!isUuid(orgId) || c === null || c.length > 1)
      return setErr(t(p.locale, 'm05.adm.rt.sim.invalid'));
    setErr('');
    const req: SimRequest = {
      mode,
      ...(c[0] ? { country: c[0] } : {}),
      ...(group ? { geoGroup: group } : {}),
    };
    void a.run(
      () =>
        loose(browserApi()).GET<OfferPage>('/v1/admin/offers', {
          params: {
            query: {
              orgId: orgId.trim().toLowerCase(),
              includeIneligible: true,
              ...(req.country ? { country: req.country } : {}),
              ...(req.geoGroup ? { geoGroup: req.geoGroup } : {}),
              limit: 50,
            },
          },
        }),
      (d) => setOut({ offers: (d as OfferPage).items, req }),
      a.overrides,
    );
  }
  const rules = out ? matchingRules(p.rules, out.req) : [];
  const split = out ? splitOffers(out.offers) : null;
  return (
    <section className="nz-card" aria-labelledby="rt-sim">
      <h2 className="nz-h2" id="rt-sim">
        {t(p.locale, 'm05.adm.rt.sim')}
      </h2>
      <Banner tone="warn">{t(p.locale, 'm05.adm.rt.sim.readOnly')}</Banner>
      <form onSubmit={run} aria-label={t(p.locale, 'm05.adm.rt.sim')} noValidate>
        <Field id="sim-org" label={t(p.locale, 'm05.adm.rt.sim.org')} error={err || undefined}>
          {(x) => (
            <Input {...x} dir="ltr" value={orgId} onChange={(e) => setOrgId(e.target.value)} />
          )}
        </Field>
        <Field id="sim-mode" label={t(p.locale, 'm05.adm.rt.modeLabel')}>
          {(x) => (
            <Select {...x} value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              {RULE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t(p.locale, `m05.adm.rt.mode.${m}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="sim-country" label={t(p.locale, 'field.country')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              maxLength={2}
              value={country}
              onChange={(e) => setCountry(e.target.value)}
            />
          )}
        </Field>
        <Field id="sim-group" label={t(p.locale, 'm05.adm.rt.sim.group')}>
          {(x) => (
            <Select {...x} value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t(p.locale, 'm05.adm.all')}</option>
              {REGION_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {t(p.locale, `m05.adm.group.${g}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'm05.adm.rt.sim.run')}
        </Button>
      </form>
      <ProviderResult n={a.notice} problem={a.problem} locale={p.locale} />
      {out && split && (
        <div aria-label={t(p.locale, 'm05.adm.rt.sim.result')} role="region">
          <h3>{t(p.locale, 'm05.adm.rt.sim.rules', { count: rules.length })}</h3>
          {rules.length === 0 ? (
            <p className="nz-muted">{t(p.locale, 'm05.adm.rt.sim.noRules')}</p>
          ) : (
            <ol>
              {rules.map((r) => (
                <li key={r.id}>
                  <Ltr>{r.ruleKey}</Ltr> —{' '}
                  {tDynamic(p.locale, `m05.adm.rt.action.${r.action.type}`, r.action.type ?? '')}{' '}
                  <Ltr>{ruleTarget(r)}</Ltr>
                </li>
              ))}
            </ol>
          )}
          <OfferList
            locale={p.locale}
            title={t(p.locale, 'm05.adm.rt.sim.eligible', { count: split.eligible.length })}
            offers={split.eligible}
            emptyText={t(p.locale, 'm05.adm.rt.sim.noEligible')}
          />
          <OfferList
            locale={p.locale}
            title={t(p.locale, 'm05.adm.rt.sim.ineligible', { count: split.ineligible.length })}
            offers={split.ineligible}
            emptyText={t(p.locale, 'm05.adm.rt.sim.noIneligible')}
            failures
          />
        </div>
      )}
    </section>
  );
}

function OfferList(p: {
  locale: Locale;
  title: string;
  offers: AdminOfferDto[];
  emptyText: string;
  failures?: boolean;
}) {
  return (
    <>
      <h3>{p.title}</h3>
      {p.offers.length === 0 ? (
        <p className="nz-muted">{p.emptyText}</p>
      ) : (
        <ul>
          {p.offers.map((o, i) => (
            <li key={o.offerId ?? `${o.providerRegionId}-${o.planRef}-${i}`}>
              <Ltr>
                {[o.provider?.key, o.providerRegionId, o.planRef].filter(Boolean).join(' / ')}
              </Ltr>{' '}
              {o.price?.amount && o.price.currency && (
                <Ltr>{formatCost(o.price.amount, o.price.currency)}</Ltr>
              )}{' '}
              {o.evidenceKind && (
                <Badge tone={o.evidenceKind === 'live' ? 'success' : 'warn'}>
                  {tDynamic(p.locale, `m05.adm.evidence.${o.evidenceKind}`, o.evidenceKind)}
                </Badge>
              )}
              {p.failures && o.failures && o.failures.length > 0 && (
                <span className="nz-muted">
                  {' '}
                  — {t(p.locale, 'm05.adm.rt.sim.failing')} <Ltr>{o.failures.join(', ')}</Ltr>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The whole routing screen body: rules, the editor (managers only) and the simulator. */
export function RoutingPanel(p: {
  locale: Locale;
  rules: RoutingRuleDto[];
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const [edit, setEdit] = useState<RoutingRuleDto | null>(null);
  return (
    <>
      <RulesTable locale={p.locale} rules={p.rules} canManage={p.canManage} onEdit={setEdit} />
      {p.canManage && (
        <RuleEditor
          key={edit ? `${edit.ruleKey}@${edit.version}` : 'new'}
          locale={p.locale}
          mfaFactorId={p.mfaFactorId}
          initial={edit ? ruleToForm(edit) : emptyRule()}
          editing={edit !== null}
          onDone={() => setEdit(null)}
        />
      )}
      <RoutingSimulator locale={p.locale} rules={p.rules} />
    </>
  );
}
