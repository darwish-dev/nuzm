/** DNet settings form (admin → Domains → Registrars → DNet): the request body, built from the form. Pure, so it is tested without a browser. */
export interface DnetForm {
  label: string;
  environment: 'sandbox' | 'production';
  baseUrl: string;
  resellerId: string;
  timeoutMs: string;
  vaultRef: string;
  apiKey: string;
  apiSecret: string;
}

export interface DnetAccountView {
  label: string;
  environment: 'sandbox' | 'production';
  settings: Record<string, unknown>;
  credentialStored: boolean;
  vaultRef?: string;
}

export const EMPTY_DNET: DnetForm = {
  label: 'DNet',
  environment: 'sandbox',
  baseUrl: '',
  resellerId: '',
  timeoutMs: '15000',
  vaultRef: '',
  apiKey: '',
  apiSecret: '',
};

/** The saved non-secret settings back into the form. Credentials are never filled in: they are write-only. */
export function dnetFormOf(a: DnetAccountView | null): DnetForm {
  if (!a) return { ...EMPTY_DNET };
  const s = a.settings;
  return {
    ...EMPTY_DNET,
    label: a.label,
    environment: a.environment,
    baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
    resellerId: typeof s.resellerId === 'string' ? s.resellerId : '',
    timeoutMs: typeof s.timeoutMs === 'number' ? String(s.timeoutMs) : EMPTY_DNET.timeoutMs,
  };
}

export type DnetFormError = 'label' | 'baseUrl' | 'timeout' | 'credentials' | 'both';

export function dnetBody(
  f: DnetForm,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: DnetFormError } {
  if (f.label.trim() === '' || f.label.length > 100) return { ok: false, error: 'label' };
  const baseUrl = f.baseUrl.trim();
  if (baseUrl !== '') {
    const isHttps = (v: string) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    };
    if (!isHttps(baseUrl)) return { ok: false, error: 'baseUrl' };
  }
  const timeoutMs = Number(f.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000)
    return { ok: false, error: 'timeout' };
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
      ...(baseUrl !== '' ? { baseUrl } : {}),
      ...(f.resellerId.trim() !== '' ? { resellerId: f.resellerId.trim() } : {}),
      timeoutMs,
      ...(apiKey !== ''
        ? { credentials: { apiKey, ...(apiSecret !== '' ? { apiSecret } : {}) } }
        : {}),
      ...(vaultRef !== '' ? { vaultRef } : {}),
    },
  };
}
