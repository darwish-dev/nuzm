'use client';
import { useEffect, useState } from 'react';
import {
  addLine,
  cartKey,
  lineFromDomain,
  lineFromPlan,
  lineFromServer,
  parseCart,
  removeLine,
  serializeCart,
  type CartLine,
} from './cart';
import type { CatalogPlan } from './hosting-catalog';

/** Browser side of the basket: localStorage per organization (every call is guarded: storage can be blocked or full), plus events so every part of the page and every tab stays in step. */
export const CART_EVENT = 'nuzm:cart';
export const CART_ADDED_EVENT = 'nuzm:cart-added';

export function readCart(orgId: string): CartLine[] {
  try {
    return parseCart(window.localStorage.getItem(cartKey(orgId)));
  } catch {
    return [];
  }
}
function writeCart(orgId: string, lines: CartLine[]): void {
  try {
    if (lines.length === 0) window.localStorage.removeItem(cartKey(orgId));
    else window.localStorage.setItem(cartKey(orgId), serializeCart(lines));
  } catch {
    /* the basket then lives only until the page is closed */
  }
  window.dispatchEvent(new CustomEvent(CART_EVENT, { detail: { orgId, lines } }));
}

/** Puts one website (one line) with this plan in the basket. `ok` is false when the basket is full. */
export function addToCart(orgId: string, plan: CatalogPlan): { ok: boolean } {
  const res = addLine(readCart(orgId), lineFromPlan(plan, crypto.randomUUID()));
  if (res.added) {
    writeCart(orgId, res.lines);
    window.dispatchEvent(
      new CustomEvent(CART_ADDED_EVENT, { detail: { orgId, label: plan.name } }),
    );
  }
  return { ok: res.added };
}
/** Puts one domain name in the basket (1 year). The registrant details and consents are asked by the domain checkout, once per name. */
export function addDomainToCart(
  orgId: string,
  domain: string,
  price: { amountMinor?: string; currency?: string } | null,
): { ok: boolean } {
  const res = addLine(readCart(orgId), lineFromDomain(domain, price, crypto.randomUUID()));
  if (res.added) {
    writeCart(orgId, res.lines);
    window.dispatchEvent(
      new CustomEvent(CART_ADDED_EVENT, {
        detail: { orgId, label: { ar: domain.toLowerCase(), en: domain.toLowerCase() } },
      }),
    );
  }
  return { ok: res.added };
}
/** Puts the chosen cloud server (offer + operating system) in the basket. */
export function addServerToCart(
  orgId: string,
  offer: Parameters<typeof lineFromServer>[0],
  image: { id: string; name: string },
): { ok: boolean } {
  const res = addLine(readCart(orgId), lineFromServer(offer, image, crypto.randomUUID()));
  if (res.added) {
    writeCart(orgId, res.lines);
    window.dispatchEvent(
      new CustomEvent(CART_ADDED_EVENT, {
        detail: { orgId, label: { ar: `${offer.plan.vcpu} vCPU`, en: `${offer.plan.vcpu} vCPU` } },
      }),
    );
  }
  return { ok: res.added };
}
export const removeFromCart = (orgId: string, id: string): void =>
  writeCart(orgId, removeLine(readCart(orgId), id));
export const clearCart = (orgId: string): void => writeCart(orgId, []);

/** The basket of this organization. It starts empty on the server and the first render, then reads the browser (no hydration mismatch). */
export function useCart(orgId: string): { lines: CartLine[]; ready: boolean } {
  const [lines, setLines] = useState<CartLine[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sync = () => setLines(readCart(orgId));
    sync();
    setReady(true);
    window.addEventListener(CART_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CART_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [orgId]);
  return { lines, ready };
}
