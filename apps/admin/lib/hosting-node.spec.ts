import { describe, expect, it } from 'vitest';
import { panelBody, panelFormOf, registerBody, setupSteps } from './hosting-node';

describe('hosting server forms', () => {
  it('registers with a normalised name and refuses a bad one', () => {
    expect(registerBody({ name: ' Hosting-KSA-1 ', instance: ' i-abc ' })).toEqual({
      ok: true,
      body: { name: 'hosting-ksa-1', computeInstanceId: 'i-abc' },
    });
    expect(registerBody({ name: 'x', instance: 'i' })).toEqual({ ok: false, error: 'name' });
    expect(registerBody({ name: 'ok-name', instance: ' ' })).toEqual({
      ok: false,
      error: 'instance',
    });
  });
  it('builds the panel body: FQDN lower-cased, a typed key as credentials, nothing secret when none typed', () => {
    const f = {
      ...panelFormOf(null),
      host: 'Panel.Example.com',
      accessKey: 'ABCDEFGHIJ0123456789:secretsecretsecret',
    };
    expect(panelBody(f)).toEqual({
      ok: true,
      body: {
        host: 'panel.example.com',
        port: 8083,
        credentials: { accessKey: 'ABCDEFGHIJ0123456789:secretsecretsecret' },
      },
    });
    const keep = panelBody({ ...panelFormOf({ panelHost: 'p.example.com', panelPort: 9000 }) });
    expect(keep).toEqual({ ok: true, body: { host: 'p.example.com', port: 9000 } });
  });
  it('refuses an IP, a URL, a bad port, a bad pin, a malformed key and key + vault together', () => {
    const base = { ...panelFormOf(null), host: 'panel.example.com' };
    expect(panelBody({ ...base, host: '10.0.0.5' })).toEqual({ ok: false, error: 'host' });
    expect(panelBody({ ...base, host: 'https://panel.example.com' })).toEqual({
      ok: false,
      error: 'host',
    });
    expect(panelBody({ ...base, port: '70000' })).toEqual({ ok: false, error: 'port' });
    expect(panelBody({ ...base, tlsPinSha256: 'abc' })).toEqual({ ok: false, error: 'pin' });
    expect(panelBody({ ...base, accessKey: 'no-colon' })).toEqual({ ok: false, error: 'key' });
    expect(
      panelBody({
        ...base,
        accessKey: 'ABCDEFGHIJ0123456789:secretsecretsecret',
        vaultRef: 'vault://a/b',
      }),
    ).toEqual({ ok: false, error: 'both' });
    const pin = Array(32).fill('aa').join(':');
    expect(panelBody({ ...base, tlsPinSha256: pin })).toMatchObject({
      ok: true,
      body: { tlsPinSha256: pin.toUpperCase() },
    });
  });
  it('shows the setup steps from what the node reports', () => {
    expect(
      setupSteps({ panelConfigured: false, health: 'unknown', status: 'maintenance' }),
    ).toEqual({ register: true, connect: false, test: false, activate: false });
    expect(
      setupSteps({
        panelConfigured: true,
        lastInventoryAt: '2026-11-24T00:00:00Z',
        health: 'healthy',
        status: 'active',
      }),
    ).toEqual({ register: true, connect: true, test: true, activate: true });
  });
});
