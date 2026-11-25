'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { formatMinor, t, type Locale, type MessageKey } from '@nuzm/i18n';
import { ButtonLink, Icon } from '@nuzm/ui';
import { totals, type CartLine } from '../lib/cart';
import { CART_ADDED_EVENT, clearCart, removeFromCart, useCart } from '../lib/cart-client';
import { memoryLabel } from '../lib/compute';
import { typeOfPlan } from '../lib/hosting-catalog';

/** A short name for a line, for the spoken "remove" button. */
const lineLabel = (l: CartLine, locale: Locale): string =>
  l.kind === 'hosting'
    ? l.name[locale]
    : l.kind === 'domain'
      ? l.domain
      : `${l.vcpu} vCPU · ${l.imageName}`;

const price = (minor: string, currency: string, locale: Locale): string => {
  try {
    return formatMinor(minor, currency, locale);
  } catch {
    return `${minor} ${currency}`; // an unlisted currency is shown as the API gave it, never guessed
  }
};

/**
 * The basket, floating in the bottom corner of every console page once something is in it. Choosing a plan opens it for a moment ("added") so the
 * customer sees it worked; it collapses to a round button with the count. It is hidden on the checkout page itself, which shows the same lines in full.
 */
export function FloatingCart({ locale, orgId }: { locale: Locale; orgId: string }) {
  const { lines, ready } = useCart(orgId);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState('');
  const pathname = usePathname() ?? '';
  useEffect(() => {
    const onAdded = (e: Event) => {
      const d = (e as CustomEvent<{ orgId: string; label: { ar: string; en: string } }>).detail;
      if (d.orgId !== orgId) return;
      setOpen(true);
      setSaid(t(locale, 'cart.added', { plan: d.label[locale] }));
    };
    window.addEventListener(CART_ADDED_EVENT, onAdded);
    return () => window.removeEventListener(CART_ADDED_EVENT, onAdded);
  }, [orgId, locale]);
  // the checkout page shows the lines itself
  if (!ready || lines.length === 0 || pathname.startsWith(`/checkout`)) return null;
  const tot = totals(lines);
  const count =
    lines.length === 1
      ? t(locale, 'cart.count.one')
      : t(locale, 'cart.count.many', { n: lines.length });
  return (
    <aside
      className="nzc-cart"
      aria-label={t(locale, 'cart.title')}
      data-open={open ? 'true' : undefined}
    >
      <p className="nz-sr" role="status">
        {said}
      </p>
      {open && (
        <div className="nzc-cart-panel">
          <div className="nzc-cart-head">
            <strong>{t(locale, 'cart.title')}</strong>
            <span className="nz-muted">{count}</span>
            <button
              type="button"
              className="nzc-cart-x"
              onClick={() => setOpen(false)}
              aria-label={t(locale, 'cart.close')}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <ul className="nzc-cart-lines">
            {lines.map((l) => (
              <li key={l.id}>
                <span className="nzc-cart-line-main">
                  {l.kind === 'hosting' ? (
                    <>
                      <b>{l.name[locale]}</b>
                      <span className="nz-muted">
                        {t(locale, `host.type.${typeOfPlan(l.key)}` as MessageKey)}
                      </span>
                    </>
                  ) : l.kind === 'server' ? (
                    <>
                      <b>
                        {t(locale, `cloud.family.${l.family}` as MessageKey)} ·{' '}
                        {t(locale, 'm05.web.plan.summary', {
                          vcpu: l.vcpu,
                          memory: memoryLabel(l.memoryMb),
                        })}
                      </b>
                      <span className="nz-muted">
                        {t(locale, 'cart.kind.server', { os: l.imageName })}
                      </span>
                    </>
                  ) : (
                    <>
                      <b dir="ltr">{l.domain}</b>
                      <span className="nz-muted">
                        {t(locale, 'cart.kind.domain', { years: l.years })}
                      </span>
                    </>
                  )}
                </span>
                <span className="nzc-cart-line-price" dir="ltr">
                  {l.priceMinor && l.currency ? price(l.priceMinor, l.currency, locale) : '—'}
                </span>
                <button
                  type="button"
                  className="nzc-cart-x"
                  onClick={() => removeFromCart(orgId, l.id)}
                  aria-label={t(locale, 'cart.remove', { plan: lineLabel(l, locale) })}
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="nzc-cart-total">
            <span>{t(locale, 'cart.total')}</span>
            {tot.currency && tot.knownMinor > 0n && !tot.mixedCurrency ? (
              <strong dir="ltr">{price(tot.knownMinor.toString(), tot.currency, locale)}</strong>
            ) : (
              <span className="nz-muted">{t(locale, 'cart.priceLater')}</span>
            )}
          </div>
          {tot.unpriced > 0 && tot.knownMinor > 0n && (
            <p className="nzc-cart-note">{t(locale, 'cart.unpriced', { n: tot.unpriced })}</p>
          )}
          <p className="nzc-cart-note">{t(locale, 'cart.beforeVat')}</p>
          <ButtonLink href={`/checkout`}>{t(locale, 'cart.checkout')}</ButtonLink>
          <button type="button" className="nzc-cart-clear" onClick={() => clearCart(orgId)}>
            {t(locale, 'cart.clear')}
          </button>
        </div>
      )}
      <button
        type="button"
        className="nzc-cart-fab"
        aria-expanded={open}
        aria-label={`${t(locale, open ? 'cart.close' : 'cart.open')} (${count})`}
        onClick={() => setOpen(!open)}
      >
        <Icon name="basket" size={22} />
        <span className="nzc-cart-badge" aria-hidden="true">
          {lines.length}
        </span>
      </button>
    </aside>
  );
}
