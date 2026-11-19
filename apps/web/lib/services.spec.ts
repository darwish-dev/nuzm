import { describe, expect, it } from 'vitest';
import { SERVICES, flagEnabled, visibleServices } from './services';

describe('dashboard services', () => {
  const all = () => true;
  it('an owner with every permission and the compute flag sees every service', () => {
    expect(visibleServices(all, all).map((s) => s.id)).toEqual(SERVICES.map((s) => s.id));
  });
  it('shows only what the role allows and hides hosting and compute while their flags are off', () => {
    const can = (p: string) =>
      ['hosting:site:read', 'compute:instance:read', 'email:read'].includes(p);
    expect(visibleServices(can, () => false).map((s) => s.id)).toEqual(['email']);
    expect(visibleServices(can, () => true).map((s) => s.id)).toEqual([
      'hosting',
      'email',
      'compute',
    ]);
  });
  it('reads a flag as true or {enabled:true} only', () => {
    expect(flagEnabled({ 'hosting.enabled': { enabled: true } }, 'hosting.enabled')).toBe(true);
    expect(flagEnabled({ 'hosting.enabled': true }, 'hosting.enabled')).toBe(true);
    for (const v of [false, 'true', 1, { enabled: 'true' }, null, {}])
      expect(flagEnabled({ k: v }, 'k')).toBe(false);
    expect(flagEnabled(undefined, 'k')).toBe(false);
  });
  it('sends a member who sees usage but not invoices to the usage page', () => {
    const can = (p: string) => p === 'usage:read';
    expect(visibleServices(can, all)).toEqual([
      expect.objectContaining({ id: 'billing', href: '/billing/usage' }),
    ]);
  });
  it('the App builder card needs builder:read and the app_builder.enabled flag', () => {
    const can = (p: string) => p === 'builder:read';
    expect(visibleServices(can, () => false).map((x) => x.id)).not.toContain('appbuilder');
    expect(visibleServices(can, (f) => f === 'app_builder.enabled')).toEqual([
      expect.objectContaining({ id: 'appbuilder', href: '/builder/apps' }),
    ]);
  });
});
