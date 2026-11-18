'use client';
import { useState, type FormEvent } from 'react';
import { formatDateTime, t, type Locale } from '@nuzm/i18n';
import { Banner, Button, Field, Input, Ltr } from '@nuzm/ui';
import { errorText } from '../lib/actions';
import { parseTopUpCredits, groupDigits } from '../lib/ai';
import { browserApi } from '../lib/client';
import { money } from '../lib/domains';
import { NoticeText } from './Feedback';

type Notice = { tone: 'error' | 'ok'; text: string } | null;
interface QuoteView {
  id: string;
  expiresAt: string;
  currency: string;
  subtotalMinor: string;
  totalMinor: string;
  taxEstimate: { taxMinor: string };
  requiresApproval: boolean;
}

/**
 * UI-M09-10 top-up: "request a quote" for AI credits (POST /v1/quotes, kind ai-credit). There is NO credit-purchase order yet (decision PA-16 is open),
 * so the card shows the quote and says plainly that completing a purchase is not available: nothing is charged and no credits are added.
 */
export function TopUpCard({ locale, canRequest }: { locale: Locale; canRequest: boolean }) {
  const [credits, setCredits] = useState('');
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [n, setN] = useState<Notice>(null);
  const [invalid, setInvalid] = useState(false);
  // one Idempotency-Key per user intent: a retry of the same request reuses it
  const [idem, setIdem] = useState(() => crypto.randomUUID());

  async function submit(e: FormEvent) {
    e.preventDefault();
    const amount = parseTopUpCredits(credits);
    setInvalid(amount === null);
    if (amount === null) return;
    setBusy(true);
    setN(null);
    const r = await browserApi().POST('/v1/quotes', {
      params: { header: { 'Idempotency-Key': idem } },
      body: { kind: 'ai-credit', items: [{ credits: amount }] },
    });
    setBusy(false);
    if (!r.response.ok) {
      const code = (r.error as { code?: string } | undefined)?.code;
      return setN({
        tone: 'error',
        text: errorText(locale, r.response.status, code, {
          422: t(locale, 'aiu.topup.refused'),
        }),
      });
    }
    setIdem(crypto.randomUUID());
    setQuote(r.data as unknown as QuoteView);
  }

  return (
    <section className="nz-card" aria-labelledby="aiu-topup-h">
      <h2 id="aiu-topup-h" className="nz-h2">
        {t(locale, 'aiu.topup.title')}
      </h2>
      <Banner tone="warn">{t(locale, 'aiu.topup.unavailable')}</Banner>
      {!canRequest ? (
        <p className="nz-muted">{t(locale, 'aiu.topup.noPermission')}</p>
      ) : (
        <form onSubmit={submit} noValidate aria-label={t(locale, 'aiu.topup.title')}>
          <Field
            id="aiu-credits"
            label={t(locale, 'aiu.topup.credits')}
            help={t(locale, 'aiu.topup.help')}
            error={invalid ? t(locale, 'aiu.topup.invalid') : undefined}
          >
            {(x) => (
              <Input
                {...x}
                dir="ltr"
                inputMode="numeric"
                autoComplete="off"
                value={credits}
                onChange={(e) => setCredits(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy}>
            {t(locale, 'aiu.topup.quote')}
          </Button>
        </form>
      )}
      <NoticeText notice={n} />
      {quote && (
        <div role="status" aria-label={t(locale, 'aiu.topup.quoteTitle')}>
          <h3 className="nz-h3">{t(locale, 'aiu.topup.quoteTitle')}</h3>
          <dl>
            <dt>{t(locale, 'aiu.topup.credits')}</dt>
            <dd>
              <Ltr>{groupDigits(credits.trim())}</Ltr>
            </dd>
            <dt>{t(locale, 'aiu.quote.subtotal')}</dt>
            <dd>
              <Ltr>{money(quote.subtotalMinor, quote.currency)}</Ltr>
            </dd>
            <dt>{t(locale, 'aiu.quote.tax')}</dt>
            <dd>
              <Ltr>{money(quote.taxEstimate.taxMinor, quote.currency)}</Ltr>
            </dd>
            <dt>{t(locale, 'aiu.quote.total')}</dt>
            <dd>
              <Ltr>{money(quote.totalMinor, quote.currency)}</Ltr>
            </dd>
            <dt>{t(locale, 'aiu.quote.expires')}</dt>
            <dd>{formatDateTime(quote.expiresAt, locale)}</dd>
          </dl>
          {quote.requiresApproval && <p>{t(locale, 'aiu.quote.approval')}</p>}
          <p className="nz-muted">{t(locale, 'aiu.topup.notCharged')}</p>
        </div>
      )}
    </section>
  );
}
