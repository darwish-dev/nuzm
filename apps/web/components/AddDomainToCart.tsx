'use client';
import { useState } from 'react';
import { t, type Locale } from '@nuzm/i18n';
import { Button, Icon } from '@nuzm/ui';
import { CART_MAX } from '../lib/cart';
import { addDomainToCart } from '../lib/cart-client';

/** "Add to cart" on a domain search result: the name goes in the basket (1 year); its registration is finished at checkout. */
export function AddDomainToCart({
  locale,
  orgId,
  name,
  price,
  label,
}: {
  locale: Locale;
  orgId: string;
  name: string;
  price: { amountMinor?: string; currency?: string } | null;
  /** The accessible name, which says which domain the button adds. */
  label?: string;
}) {
  const [state, setState] = useState<'idle' | 'added' | 'full'>('idle');
  return (
    <>
      <Button
        aria-label={label}
        onClick={() => {
          setState(addDomainToCart(orgId, name, price).ok ? 'added' : 'full');
          window.setTimeout(() => setState('idle'), 2200);
        }}
      >
        {state === 'added' ? (
          <>
            <Icon name="check" size={16} /> {t(locale, 'cart.addedBtn')}
          </>
        ) : (
          <>
            <Icon name="basket" size={16} /> {t(locale, 'cart.add')}
          </>
        )}
      </Button>
      {state === 'full' && (
        <span className="nz-error-text" role="alert">
          {t(locale, 'cart.full', { max: CART_MAX })}
        </span>
      )}
    </>
  );
}
