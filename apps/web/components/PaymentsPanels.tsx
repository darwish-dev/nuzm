'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatMinor, t, tDynamic, type Locale } from '@nuzm/i18n';
import { Badge, Button, ButtonLink, Field, Input, Ltr, Select, Table } from '@nuzm/ui';
import { useAction } from '../lib/actions';
import { browserApi } from '../lib/client';
import { toMinor } from '../lib/billing';
import {
  PAYMENT_FINAL,
  SANDBOX_CARDS,
  cardState,
  previewMessage,
  sandboxToken,
  statusTone,
  type SandboxCard,
} from '../lib/payments';
import { NoticeText } from './Feedback';

export interface MethodRow {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  expiring: boolean;
}
export interface PlanOption {
  key: string;
  name: string;
  versionId: string;
}
const key = () => crypto.randomUUID();
const returnUrl = (_locale: Locale) => `${window.location.origin}/billing/payment-return`;
const REMEMBER = 'nuzm.lastPayment';

// ---- UI-M03-01: payment methods ------------------------------------------------------------------------------------------

export function MethodsTable(p: {
  locale: Locale;
  rows: MethodRow[];
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const now = new Date();
  return (
    <div>
      <Table
        caption={t(p.locale, 'pay.methods.title')}
        rows={p.rows}
        rowKey={(m) => m.id}
        columns={[
          {
            key: 'c',
            header: t(p.locale, 'pay.col.card'),
            render: (m) => (
              <Ltr>{t(p.locale, 'pay.card.ending', { brand: m.brand, last4: m.last4 })}</Ltr>
            ),
          },
          {
            key: 'e',
            header: t(p.locale, 'pay.col.expires'),
            icon: 'calendar',
            render: (m) => <Ltr>{`${String(m.expMonth).padStart(2, '0')}/${m.expYear}`}</Ltr>,
          },
          {
            key: 's',
            header: t(p.locale, 'pay.col.status'),
            icon: 'pulse',
            render: (m) => {
              const expired = cardState(m.expMonth, m.expYear, now) === 'expired';
              return (
                <span className="nz-row">
                  {m.isDefault && (
                    <Badge tone="success">{t(p.locale, 'pay.methods.default')}</Badge>
                  )}
                  {expired ? (
                    <Badge tone="danger">{t(p.locale, 'pay.methods.expired')}</Badge>
                  ) : (
                    m.expiring && <Badge tone="warn">{t(p.locale, 'pay.methods.expiring')}</Badge>
                  )}
                </span>
              );
            },
          },
          {
            key: 'a',
            header: t(p.locale, 'pay.col.actions'),
            icon: 'code',
            render: (m) =>
              p.canManage ? (
                <span className="nz-row">
                  {!m.isDefault && (
                    <Button
                      variant="secondary"
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(
                          () =>
                            browserApi().POST('/v1/billing/payment-methods/{id}/default', {
                              params: { path: { id: m.id }, header: { 'Idempotency-Key': key() } },
                            }),
                          () => {
                            a.setNotice({
                              tone: 'ok',
                              text: t(p.locale, 'pay.methods.defaultSet'),
                            });
                            router.refresh();
                          },
                        )
                      }
                    >
                      {t(p.locale, 'pay.methods.makeDefault')}
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    disabled={a.busy}
                    onClick={() =>
                      void a.run(
                        () =>
                          browserApi().DELETE('/v1/billing/payment-methods/{id}', {
                            params: { path: { id: m.id } },
                          }),
                        () => {
                          a.setNotice({ tone: 'ok', text: t(p.locale, 'pay.methods.removed') });
                          router.refresh();
                        },
                        { 409: t(p.locale, 'pay.methods.inUse') },
                      )
                    }
                  >
                    {t(p.locale, 'pay.methods.remove')}
                  </Button>
                </span>
              ) : null,
          },
        ]}
      />
      <NoticeText notice={a.notice} />
      {a.panel}
    </div>
  );
}

// ---- UI-M03-02: add a payment method (the sandbox PSP's "hosted fields") ----------------------------------------------------

export function AddMethodForm(p: {
  locale: Locale;
  sandbox: boolean;
  mfaFactorId: string | null;
  /** Where to go once the card is saved (a path on this site); the payments page by default. */
  next?: string;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [kind, setKind] = useState<SandboxCard>('success');
  function submit(e: FormEvent) {
    e.preventDefault();
    // a distinct test card per save; NO card number exists anywhere in this form
    const token = sandboxToken(kind, crypto.randomUUID().slice(0, 8));
    void a.run(
      () =>
        browserApi().POST('/v1/billing/payment-methods', {
          params: { header: { 'Idempotency-Key': key() } },
          body: { provider: 'mock', setupToken: token },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'pay.add.saved') });
        router.push(p.next ?? `/billing/payments#methods`);
        router.refresh();
      },
      { 409: t(p.locale, 'pay.add.duplicate'), 422: t(p.locale, 'pay.add.refused') },
    );
  }
  if (!p.sandbox) return <p className="nz-muted">{t(p.locale, 'pay.add.unavailable')}</p>;
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'pay.add.title')}>
      <p className="nz-muted">{t(p.locale, 'pay.add.sandbox')}</p>
      <Field id="scenario" label={t(p.locale, 'pay.add.scenario')}>
        {(x) => (
          <Select {...x} value={kind} onChange={(e) => setKind(e.target.value as SandboxCard)}>
            {SANDBOX_CARDS.map((c) => (
              <option key={c} value={c}>
                {t(p.locale, `pay.add.s.${c}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'pay.add.submit')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- paying (invoice or wallet top-up): shared by UI-M03-06, -09 ------------------------------------------------------------

type PayOutcome = { tone: 'ok' | 'error'; text: string; action?: string } | null;
interface PaymentRes {
  id: string;
  status: string;
  failureCode: string | null;
  nextAction: { type: string; url: string } | null;
}

/** Poll a payment that is still processing (the page refreshes when it ends). */
function usePoll(locale: Locale, onDone: (p: PaymentRes) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return (id: string) => {
    let n = 0;
    const tick = async () => {
      const r = await browserApi().GET('/v1/billing/payments/{id}', { params: { path: { id } } });
      if (
        r.response.ok &&
        r.data &&
        (PAYMENT_FINAL.has(r.data.status) || r.data.status === 'requires_action')
      )
        return onDone(r.data as PaymentRes);
      if (++n < 30) timer.current = setTimeout(() => void tick(), 2000);
    };
    timer.current = setTimeout(() => void tick(), 1500);
  };
}

function outcomeOf(locale: Locale, pay: PaymentRes, kind: 'invoice' | 'topup'): PayOutcome {
  if (pay.status === 'succeeded')
    return { tone: 'ok', text: t(locale, kind === 'invoice' ? 'inv.pay.success' : 'wallet.ok') };
  if (pay.status === 'processing')
    return {
      tone: 'ok',
      text: t(locale, kind === 'invoice' ? 'inv.pay.processing' : 'wallet.processing'),
    };
  if (pay.status === 'requires_action')
    return {
      tone: 'ok',
      text: t(locale, kind === 'invoice' ? 'inv.pay.action' : 'wallet.action'),
      ...(pay.nextAction ? { action: pay.nextAction.url } : {}),
    };
  return {
    tone: 'error',
    text: t(locale, kind === 'invoice' ? 'inv.pay.failed' : 'wallet.failed', {
      code: pay.failureCode ?? pay.status,
    }),
  };
}

function MethodSelect(p: {
  locale: Locale;
  methods: MethodRow[];
  value: string;
  onChange: (v: string) => void;
  id: string;
  label: string;
}) {
  return (
    <Field id={p.id} label={p.label}>
      {(x) => (
        <Select {...x} value={p.value} onChange={(e) => p.onChange(e.target.value)}>
          {p.methods.map((m) => (
            <option key={m.id} value={m.id}>
              {t(p.locale, 'pay.card.ending', { brand: m.brand, last4: m.last4 })}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function PaymentResult(p: { locale: Locale; outcome: PayOutcome }) {
  if (!p.outcome) return null;
  return (
    <>
      <NoticeText notice={{ tone: p.outcome.tone, text: p.outcome.text }} />
      {p.outcome.action && (
        <ButtonLink variant="secondary" href={p.outcome.action}>
          {t(p.locale, 'inv.pay.continue')}
        </ButtonLink>
      )}
    </>
  );
}

// ---- UI-M03-06: pay an invoice ----------------------------------------------------------------------------------------------

export function PayInvoiceForm(p: {
  locale: Locale;
  invoiceId: string;
  remainingMinor: string;
  currency: string;
  methods: MethodRow[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [method, setMethod] = useState(
    p.methods.find((m) => m.isDefault)?.id ?? p.methods[0]?.id ?? '',
  );
  const [outcome, setOutcome] = useState<PayOutcome>(null);
  const poll = usePoll(p.locale, (pay) => {
    setOutcome(outcomeOf(p.locale, pay, 'invoice'));
    router.refresh();
  });
  if (p.methods.length === 0)
    return (
      <p>
        {t(p.locale, 'inv.pay.noMethod')}{' '}
        <a href={`/billing/payment-methods/add`}>{t(p.locale, 'pay.methods.add')}</a>
      </p>
    );
  function submit(e: FormEvent) {
    e.preventDefault();
    setOutcome(null);
    void a.run(
      () =>
        browserApi().POST('/v1/billing/payments', {
          params: { header: { 'Idempotency-Key': key() } },
          body: { invoiceId: p.invoiceId, paymentMethodId: method, returnUrl: returnUrl(p.locale) },
        }),
      (pay) => {
        const res = pay as PaymentRes;
        sessionStorage.setItem(REMEMBER, res.id);
        setOutcome(outcomeOf(p.locale, res, 'invoice'));
        if (res.status === 'processing') poll(res.id);
        if (res.status === 'succeeded') router.refresh();
      },
      { 409: t(p.locale, 'inv.pay.refused'), 422: t(p.locale, 'inv.pay.refused') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'inv.payNow')}>
      <MethodSelect
        locale={p.locale}
        methods={p.methods}
        value={method}
        onChange={setMethod}
        id="pay-method"
        label={t(p.locale, 'inv.pay.method')}
      />
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'inv.pay.submit', {
          amount: formatMinor(p.remainingMinor, p.currency, p.locale),
        })}
      </Button>
      <PaymentResult locale={p.locale} outcome={outcome} />
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M03-09: wallet top-up -----------------------------------------------------------------------------------------------

export function TopupForm(p: {
  locale: Locale;
  methods: MethodRow[];
  minMinor: string;
  maxMinor: string;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(
    p.methods.find((m) => m.isDefault)?.id ?? p.methods[0]?.id ?? '',
  );
  const [local, setLocal] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PayOutcome>(null);
  const poll = usePoll(p.locale, (pay) => {
    setOutcome(outcomeOf(p.locale, pay, 'topup'));
    router.refresh();
  });
  if (p.methods.length === 0) return <p>{t(p.locale, 'wallet.noMethod')}</p>;
  function submit(e: FormEvent) {
    e.preventDefault();
    setLocal(null);
    setOutcome(null);
    const minor = toMinor(amount);
    if (!minor || BigInt(minor) < BigInt(p.minMinor) || BigInt(minor) > BigInt(p.maxMinor))
      return setLocal(t(p.locale, 'wallet.invalid'));
    void a.run(
      () =>
        browserApi().POST('/v1/billing/wallet-topups', {
          params: { header: { 'Idempotency-Key': key() } },
          body: {
            amount: { amount: minor, currency: 'SAR' },
            paymentMethodId: method,
            returnUrl: returnUrl(p.locale),
          },
        }),
      (top) => {
        const pay = (top as { payment: PaymentRes }).payment;
        sessionStorage.setItem(REMEMBER, pay.id);
        setOutcome(outcomeOf(p.locale, pay, 'topup'));
        if (pay.status === 'processing') poll(pay.id);
        if (pay.status === 'succeeded') {
          setAmount('');
          router.refresh();
        }
      },
      { 422: t(p.locale, 'wallet.invalid') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'wallet.topup')}>
      <Field
        id="topup-amount"
        label={t(p.locale, 'wallet.amount')}
        help={t(p.locale, 'wallet.help', {
          min: formatMinor(p.minMinor, 'SAR', p.locale),
          max: formatMinor(p.maxMinor, 'SAR', p.locale),
        })}
      >
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        )}
      </Field>
      <MethodSelect
        locale={p.locale}
        methods={p.methods}
        value={method}
        onChange={setMethod}
        id="topup-method"
        label={t(p.locale, 'wallet.method')}
      />
      <Button type="submit" disabled={a.busy}>
        {t(p.locale, 'wallet.submit')}
      </Button>
      {local && <NoticeText notice={{ tone: 'error', text: local }} />}
      <PaymentResult locale={p.locale} outcome={outcome} />
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M03-03/04: subscribe, change, cancel ---------------------------------------------------------------------------------

export function SubscribeForm(p: {
  locale: Locale;
  plans: PlanOption[];
  methods: MethodRow[];
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [plan, setPlan] = useState(p.plans[0]?.versionId ?? '');
  const [method, setMethod] = useState(
    p.methods.find((m) => m.isDefault)?.id ?? p.methods[0]?.id ?? '',
  );
  const [qty, setQty] = useState('1');
  if (p.methods.length === 0)
    return (
      <p>
        {t(p.locale, 'sub.needMethod')}{' '}
        <a href={`/billing/payment-methods/add`}>{t(p.locale, 'pay.methods.add')}</a>
      </p>
    );
  function submit(e: FormEvent) {
    e.preventDefault();
    void a.run(
      () =>
        browserApi().POST('/v1/billing/subscriptions', {
          params: { header: { 'Idempotency-Key': key() } },
          body: { planVersionId: plan, paymentMethodId: method, quantity: Number(qty) || 1 },
        }),
      (s) => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'sub.created') });
        router.push(`/billing/subscriptions/${(s as { id: string }).id}`);
        router.refresh();
      },
      { 409: t(p.locale, 'sub.exists'), 422: t(p.locale, 'sub.noPrice') },
    );
  }
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'sub.subscribe')}>
      <Field id="sub-plan" label={t(p.locale, 'sub.pickPlan')}>
        {(x) => (
          <Select {...x} value={plan} onChange={(e) => setPlan(e.target.value)}>
            {p.plans.map((pl) => (
              <option key={pl.versionId} value={pl.versionId}>
                {pl.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <MethodSelect
        locale={p.locale}
        methods={p.methods}
        value={method}
        onChange={setMethod}
        id="sub-method"
        label={t(p.locale, 'sub.method')}
      />
      <Field id="sub-qty" label={t(p.locale, 'sub.quantity')}>
        {(x) => (
          <Input
            {...x}
            dir="ltr"
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
        )}
      </Field>
      <Button type="submit" disabled={a.busy || p.plans.length === 0}>
        {t(p.locale, 'sub.subscribe')}
      </Button>
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

interface Preview {
  effect: 'charge' | 'credit' | 'none';
  netMinor: string;
}
export function SubscriptionActions(p: {
  locale: Locale;
  id: string;
  version: number;
  currency: string;
  planVersionId: string;
  quantity: number;
  plans: PlanOption[];
  cancelAtPeriodEnd: boolean;
  periodEnd: string;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const [plan, setPlan] = useState(p.planVersionId);
  const [qty, setQty] = useState(String(p.quantity));
  const [mode, setMode] = useState<'prorate' | 'none'>('prorate');
  const [preview, setPreview] = useState<Preview | null>(null);
  if (!p.canManage) return null;
  const body = () => ({
    ...(plan !== p.planVersionId ? { planVersionId: plan } : {}),
    ...(Number(qty) !== p.quantity ? { quantity: Number(qty) } : {}),
    prorationMode: mode,
  });
  const changed = plan !== p.planVersionId || Number(qty) !== p.quantity;
  const conflicts = {
    412: t(p.locale, 'sub.stale'),
    428: t(p.locale, 'sub.stale'),
    422: t(p.locale, 'sub.noPrice'),
  };
  return (
    <div>
      <form
        className="nz-card"
        aria-label={t(p.locale, 'sub.changePlan')}
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(
            () =>
              browserApi().PATCH('/v1/billing/subscriptions/{id}', {
                params: { path: { id: p.id }, header: { 'If-Match': `"${p.version}"` } },
                body: body(),
              }),
            () => {
              a.setNotice({ tone: 'ok', text: t(p.locale, 'sub.changed') });
              setPreview(null);
              router.refresh();
            },
            conflicts,
          );
        }}
      >
        <h2 className="nz-h2">{t(p.locale, 'sub.changePlan')}</h2>
        <Field id="chg-plan" label={t(p.locale, 'sub.newPlan')}>
          {(x) => (
            <Select
              {...x}
              value={plan}
              onChange={(e) => {
                setPlan(e.target.value);
                setPreview(null);
              }}
            >
              {p.plans.map((pl) => (
                <option key={pl.versionId} value={pl.versionId}>
                  {pl.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field id="chg-qty" label={t(p.locale, 'sub.quantity')}>
          {(x) => (
            <Input
              {...x}
              dir="ltr"
              inputMode="numeric"
              value={qty}
              onChange={(e) => {
                setQty(e.target.value);
                setPreview(null);
              }}
              required
            />
          )}
        </Field>
        <Field id="chg-mode" label={t(p.locale, 'sub.proration')}>
          {(x) => (
            <Select
              {...x}
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as 'prorate' | 'none');
                setPreview(null);
              }}
            >
              <option value="prorate">{t(p.locale, 'sub.prorate')}</option>
              <option value="none">{t(p.locale, 'sub.noProration')}</option>
            </Select>
          )}
        </Field>
        <div className="nz-row">
          <Button
            type="button"
            variant="secondary"
            disabled={a.busy || !changed}
            onClick={() =>
              void a.run(
                () =>
                  browserApi().PATCH('/v1/billing/subscriptions/{id}', {
                    params: { path: { id: p.id } },
                    body: { ...body(), preview: true },
                  }),
                (r) => setPreview((r as { proration: Preview }).proration),
                conflicts,
              )
            }
          >
            {t(p.locale, 'sub.preview')}
          </Button>
          <Button type="submit" disabled={a.busy || !changed}>
            {t(p.locale, 'sub.apply')}
          </Button>
        </div>
        {preview && (
          <p role="status">
            {(() => {
              const m = previewMessage(preview);
              return t(
                p.locale,
                m.key,
                m.amountMinor
                  ? { amount: formatMinor(m.amountMinor, p.currency, p.locale) }
                  : undefined,
              );
            })()}
          </p>
        )}
      </form>
      {!p.cancelAtPeriodEnd && (
        <div className="nz-card">
          <p className="nz-muted">{t(p.locale, 'sub.cancelHelp', { date: p.periodEnd })}</p>
          <Button
            variant="secondary"
            disabled={a.busy}
            onClick={() =>
              void a.run(
                () =>
                  browserApi().POST('/v1/billing/subscriptions/{id}/cancellation', {
                    params: { path: { id: p.id } },
                    body: {},
                  }),
                () => {
                  a.setNotice({ tone: 'ok', text: t(p.locale, 'sub.cancelDone') });
                  router.refresh();
                },
              )
            }
          >
            {t(p.locale, 'sub.cancel')}
          </Button>
        </div>
      )}
      <NoticeText notice={a.notice} />
      {a.panel}
    </div>
  );
}

// ---- UI-M03-10: tax profile --------------------------------------------------------------------------------------------------

export interface TaxProfileDto {
  buyerType: 'b2b' | 'b2c';
  legalName: { ar: string; en: string };
  vatNumber: string | null;
  crNumber: string | null;
  address: Record<string, string>;
  version: number;
}
export function TaxProfileForm(p: {
  locale: Locale;
  profile: TaxProfileDto | null;
  canManage: boolean;
  mfaFactorId: string | null;
}) {
  const router = useRouter();
  const a = useAction(p.locale, p.mfaFactorId);
  const pr = p.profile;
  const [type, setType] = useState<'b2b' | 'b2c'>(pr?.buyerType ?? 'b2c');
  const [nameAr, setNameAr] = useState(pr?.legalName.ar ?? '');
  const [nameEn, setNameEn] = useState(pr?.legalName.en ?? '');
  const [vat, setVat] = useState(pr?.vatNumber ?? '');
  const [cr, setCr] = useState(pr?.crNumber ?? '');
  const [addr, setAddr] = useState<Record<string, string>>({
    street: '',
    buildingNumber: '',
    district: '',
    city: '',
    postalCode: '',
    country: 'SA',
    ...(pr?.address ?? {}),
  });
  const set = (k: string, v: string) => setAddr((x) => ({ ...x, [k]: v }));
  function submit(e: FormEvent) {
    e.preventDefault();
    const address = Object.fromEntries(Object.entries(addr).filter(([, v]) => v.trim() !== ''));
    void a.run(
      () =>
        browserApi().PUT('/v1/billing/tax-profile', {
          params: { header: pr ? { 'If-Match': `"${pr.version}"` } : {} },
          body: {
            buyerType: type,
            legalName: { ar: nameAr, en: nameEn },
            vatNumber: vat.trim() || null,
            crNumber: cr.trim() || null,
            address,
          },
        }),
      () => {
        a.setNotice({ tone: 'ok', text: t(p.locale, 'tax.saved') });
        router.refresh();
      },
      {
        412: t(p.locale, 'tax.conflict'),
        428: t(p.locale, 'tax.conflict'),
        422: t(p.locale, 'tax.invalid'),
      },
    );
  }
  const text = (
    id: string,
    label: string,
    value: string,
    on: (v: string) => void,
    ltr = false,
    required = false,
  ) => (
    <Field id={id} label={label}>
      {(x) => (
        <Input
          {...x}
          {...(ltr ? { dir: 'ltr' } : {})}
          value={value}
          onChange={(e) => on(e.target.value)}
          required={required}
          disabled={!p.canManage}
        />
      )}
    </Field>
  );
  return (
    <form onSubmit={submit} className="nz-card" aria-label={t(p.locale, 'tax.title')}>
      <Field id="tax-type" label={t(p.locale, 'tax.f.type')}>
        {(x) => (
          <Select
            {...x}
            value={type}
            onChange={(e) => setType(e.target.value as 'b2b' | 'b2c')}
            disabled={!p.canManage}
          >
            <option value="b2c">{t(p.locale, 'tax.b2c')}</option>
            <option value="b2b">{t(p.locale, 'tax.b2b')}</option>
          </Select>
        )}
      </Field>
      {text('tax-name-ar', t(p.locale, 'tax.f.nameAr'), nameAr, setNameAr, false, true)}
      {text('tax-name-en', t(p.locale, 'tax.f.nameEn'), nameEn, setNameEn, true, true)}
      {text('tax-vat', t(p.locale, 'tax.f.vat'), vat, setVat, true, type === 'b2b')}
      {text('tax-cr', t(p.locale, 'tax.f.cr'), cr, setCr, true)}
      {text('tax-street', t(p.locale, 'tax.f.street'), addr.street ?? '', (v) => set('street', v))}
      {text(
        'tax-building',
        t(p.locale, 'tax.f.building'),
        addr.buildingNumber ?? '',
        (v) => set('buildingNumber', v),
        true,
      )}
      {text('tax-district', t(p.locale, 'tax.f.district'), addr.district ?? '', (v) =>
        set('district', v),
      )}
      {text('tax-city', t(p.locale, 'tax.f.city'), addr.city ?? '', (v) => set('city', v))}
      {text(
        'tax-postal',
        t(p.locale, 'tax.f.postal'),
        addr.postalCode ?? '',
        (v) => set('postalCode', v),
        true,
      )}
      {text(
        'tax-country',
        t(p.locale, 'tax.f.country'),
        addr.country ?? '',
        (v) => set('country', v.toUpperCase()),
        true,
      )}
      {p.canManage && (
        <Button type="submit" disabled={a.busy}>
          {t(p.locale, 'action.save')}
        </Button>
      )}
      <NoticeText notice={a.notice} />
      {a.panel}
    </form>
  );
}

// ---- UI-M03-12: payment return ------------------------------------------------------------------------------------------------

export function PaymentReturn(p: { locale: Locale; paymentId: string | null }) {
  const [state, setState] = useState<{
    pay: (PaymentRes & { invoiceId: string | null; walletTopupId: string | null }) | null;
    missing: boolean;
  }>({ pay: null, missing: false });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = p.paymentId ?? sessionStorage.getItem(REMEMBER);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return setState({ pay: null, missing: true });
    let stop = false;
    let n = 0;
    const load = async () => {
      const r = await browserApi().GET('/v1/billing/payments/{id}', { params: { path: { id } } });
      if (stop) return;
      if (!r.response.ok || !r.data) return setState({ pay: null, missing: true });
      setState({ pay: r.data as never, missing: false });
      if (!PAYMENT_FINAL.has(r.data.status) && r.data.status !== 'requires_action' && ++n < 30)
        setTimeout(() => void load(), 2000);
    };
    void load();
    return () => {
      stop = true;
    };
  }, [p.paymentId, tick]);
  if (state.missing) return <p role="status">{t(p.locale, 'ret.missing')}</p>;
  if (!state.pay) return <p role="status">{t(p.locale, 'ret.pending')}</p>;
  const pay = state.pay;
  return (
    <div className="nz-card" aria-live="polite">
      <p className="nz-row">
        <Badge tone={statusTone(pay.status)}>
          {tDynamic(p.locale, `pay.status.${pay.status}`, pay.status)}
        </Badge>
      </p>
      <p role="status">
        {pay.status === 'succeeded' ||
        pay.status === 'partially_refunded' ||
        pay.status === 'refunded'
          ? t(p.locale, 'ret.success')
          : pay.status === 'failed' || pay.status === 'cancelled'
            ? t(p.locale, 'ret.failed', { code: pay.failureCode ?? pay.status })
            : pay.status === 'requires_action'
              ? t(p.locale, 'ret.action')
              : t(p.locale, 'ret.pending')}
      </p>
      <div className="nz-row">
        {pay.status === 'requires_action' && pay.nextAction && (
          <ButtonLink variant="secondary" href={pay.nextAction.url}>
            {t(p.locale, 'ret.continue')}
          </ButtonLink>
        )}
        {pay.invoiceId && (
          <ButtonLink variant="secondary" href={`/billing/invoices/${pay.invoiceId}`}>
            {t(p.locale, 'ret.invoice')}
          </ButtonLink>
        )}
        {pay.walletTopupId && (
          <ButtonLink variant="secondary" href={`/billing/payments#wallet`}>
            {t(p.locale, 'ret.wallet')}
          </ButtonLink>
        )}
        <Button variant="secondary" onClick={() => setTick((n) => n + 1)}>
          {t(p.locale, 'ret.again')}
        </Button>
      </div>
    </div>
  );
}
