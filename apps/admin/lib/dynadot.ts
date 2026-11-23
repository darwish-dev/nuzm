/** Dynadot settings form (admin → Domains → Registrars → Dynadot): the request body, built from the form. Pure, so it is tested without a browser. */
export interface DynadotForm {
  label: string;
  environment: 'sandbox' | 'production';
  timeoutMs: string;
  searchBatch: string;
  dataRegion: string;
  currency: string;
  vaultRef: string;
  apiKey: string;
  apiSecret: string;
}

export interface DynadotAccountView {
  id: string;
  label: string;
  environment: 'sandbox' | 'production';
  dataRegion: string;
  currency: string;
  settings: Record<string, unknown>;
  credentialStored: boolean;
  enabled: boolean;
}

export const EMPTY_DYNADOT: DynadotForm = {
  label: 'Dynadot',
  environment: 'sandbox',
  timeoutMs: '15000',
  searchBatch: '1',
  dataRegion: 'US',
  currency: 'USD',
  vaultRef: '',
  apiKey: '',
  apiSecret: '',
};

/** The saved non-secret settings back into the form. Credentials are never filled in: they are write-only. */
export function dynadotFormOf(a: DynadotAccountView | null): DynadotForm {
  if (!a) return { ...EMPTY_DYNADOT };
  const s = a.settings;
  return {
    ...EMPTY_DYNADOT,
    label: a.label,
    environment: a.environment,
    dataRegion: a.dataRegion,
    currency: a.currency,
    timeoutMs: typeof s.timeoutMs === 'number' ? String(s.timeoutMs) : EMPTY_DYNADOT.timeoutMs,
    searchBatch:
      typeof s.searchBatch === 'number' ? String(s.searchBatch) : EMPTY_DYNADOT.searchBatch,
  };
}

export type DynadotFormError =
  'label' | 'timeout' | 'batch' | 'region' | 'currency' | 'credentials' | 'both';

export function dynadotBody(
  f: DynadotForm,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: DynadotFormError } {
  if (f.label.trim() === '' || f.label.length > 100) return { ok: false, error: 'label' };
  const timeoutMs = Number(f.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    return { ok: false, error: 'timeout' };
  const searchBatch = Number(f.searchBatch);
  if (!Number.isInteger(searchBatch) || searchBatch < 1 || searchBatch > 100)
    return { ok: false, error: 'batch' };
  const dataRegion = f.dataRegion.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9-]{1,39}$/.test(dataRegion)) return { ok: false, error: 'region' };
  const currency = f.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'currency' };
  const apiKey = f.apiKey.trim();
  const apiSecret = f.apiSecret.trim();
  const vaultRef = f.vaultRef.trim();
  if (apiSecret !== '' && apiKey === '') return { ok: false, error: 'credentials' };
  if (apiKey !== '' && vaultRef !== '') return { ok: false, error: 'both' };
  if (vaultRef !== '' && !/^vault:\/\/\S+$/.test(vaultRef))
    return { ok: false, error: 'credentials' };
  return {
    ok: true,
    body: {
      label: f.label.trim(),
      environment: f.environment,
      timeoutMs,
      searchBatch,
      dataRegion,
      currency,
      ...(apiKey !== ''
        ? { credentials: { apiKey, ...(apiSecret !== '' ? { apiSecret } : {}) } }
        : {}),
      ...(vaultRef !== '' ? { vaultRef } : {}),
    },
  };
}
