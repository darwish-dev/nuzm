import { describe, expect, it } from 'vitest';
import { EMPTY_DYNADOT, dynadotBody, dynadotFormOf } from './dynadot';

describe('Dynadot settings body', () => {
  it('builds the body with typed credentials and normalises region and currency', () => {
    const r = dynadotBody({
      ...EMPTY_DYNADOT,
      dataRegion: 'us',
      currency: 'usd',
      apiKey: ' key-123456789 ',
    });
    expect(r).toEqual({
      ok: true,
      body: {
        label: 'Dynadot',
        environment: 'sandbox',
        timeoutMs: 15000,
        searchBatch: 1,
        dataRegion: 'US',
        currency: 'USD',
        credentials: { apiKey: 'key-123456789' },
      },
    });
  });
  it('sends nothing secret when no key was typed (the stored one is kept)', () => {
    const r = dynadotBody({ ...EMPTY_DYNADOT });
    expect(r.ok && 'credentials' in r.body).toBe(false);
  });
  it('refuses bad values with the field that is wrong', () => {
    expect(dynadotBody({ ...EMPTY_DYNADOT, label: ' ' })).toEqual({ ok: false, error: 'label' });
    expect(dynadotBody({ ...EMPTY_DYNADOT, timeoutMs: '5' })).toEqual({
      ok: false,
      error: 'timeout',
    });
    expect(dynadotBody({ ...EMPTY_DYNADOT, searchBatch: '101' })).toEqual({
      ok: false,
      error: 'batch',
    });
    expect(dynadotBody({ ...EMPTY_DYNADOT, dataRegion: '!' })).toEqual({
      ok: false,
      error: 'region',
    });
    expect(dynadotBody({ ...EMPTY_DYNADOT, currency: 'US' })).toEqual({
      ok: false,
      error: 'currency',
    });
    expect(dynadotBody({ ...EMPTY_DYNADOT, apiSecret: 'only-secret-1234' })).toEqual({
      ok: false,
      error: 'credentials',
    });
    expect(
      dynadotBody({ ...EMPTY_DYNADOT, apiKey: 'k-12345678', vaultRef: 'vault://x/y' }),
    ).toEqual({ ok: false, error: 'both' });
  });
  it('fills the form from the saved account but never a credential', () => {
    const f = dynadotFormOf({
      id: 'i',
      label: 'Main',
      environment: 'production',
      dataRegion: 'US',
      currency: 'EUR',
      settings: { timeoutMs: 20000, searchBatch: 50 },
      credentialStored: true,
      enabled: true,
    });
    expect(f).toMatchObject({
      label: 'Main',
      environment: 'production',
      currency: 'EUR',
      timeoutMs: '20000',
      searchBatch: '50',
      apiKey: '',
      apiSecret: '',
    });
  });
});
