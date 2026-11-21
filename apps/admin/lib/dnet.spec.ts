import { describe, expect, it } from 'vitest';
import { dnetBody, dnetFormOf, EMPTY_DNET } from './dnet';

describe('dnetBody', () => {
  it('sends only what was filled; empty optional fields are left out', () => {
    const r = dnetBody({
      ...EMPTY_DNET,
      baseUrl: 'https://api.example.test',
      apiKey: ' k-12345678 ',
    });
    expect(r).toEqual({
      ok: true,
      body: {
        label: 'DNet',
        environment: 'sandbox',
        baseUrl: 'https://api.example.test',
        timeoutMs: 15000,
        credentials: { apiKey: 'k-12345678' },
      },
    });
  });
  it('checks the form before sending', () => {
    expect(dnetBody({ ...EMPTY_DNET, label: ' ' })).toEqual({ ok: false, error: 'label' });
    expect(dnetBody({ ...EMPTY_DNET, baseUrl: 'http://x.test' })).toEqual({
      ok: false,
      error: 'baseUrl',
    });
    expect(dnetBody({ ...EMPTY_DNET, timeoutMs: '5' })).toEqual({ ok: false, error: 'timeout' });
    expect(dnetBody({ ...EMPTY_DNET, apiSecret: 'abcdefgh' })).toEqual({
      ok: false,
      error: 'credentials',
    });
    expect(dnetBody({ ...EMPTY_DNET, apiKey: 'abcdefgh', vaultRef: 'vault://a/b' })).toEqual({
      ok: false,
      error: 'both',
    });
  });
  it('never puts a credential back into the form', () => {
    const f = dnetFormOf({
      label: 'DNet',
      environment: 'production',
      settings: { baseUrl: 'https://a.test', resellerId: 'R1', timeoutMs: 9000 },
      credentialStored: true,
    });
    expect(f).toMatchObject({
      baseUrl: 'https://a.test',
      resellerId: 'R1',
      timeoutMs: '9000',
      environment: 'production',
    });
    expect(f.apiKey).toBe('');
    expect(f.apiSecret).toBe('');
    expect(f.vaultRef).toBe('');
  });
});
