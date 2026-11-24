// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '@nuzm/i18n';
import { HostingInsights } from './HostingInsights';

afterEach(cleanup);
const base = {
  runtime: 'php:8.3',
  planName: 'Starter',
  domains: [{ domain: 'a.com', state: 'active' }],
  limits: { disk_mb: 10240, bandwidth_gb: 100, memory_mb: 1024 } as Record<string, number>,
  used: {} as Record<string, number | undefined>,
  diskLimitMb: 10240 as number | null,
  diskUsedMb: undefined as number | undefined,
};

describe('website insights', () => {
  it('says nothing needs attention for a healthy site, and that usage comes from the node', () => {
    render(<HostingInsights locale="en" site={base} />);
    expect(screen.getByText(t('en', 'host.ins.attn.ok'))).toBeTruthy();
    // not measured: the numbers are plan limits and the page says so
    expect(screen.getByText(t('en', 'host.resources.limitsNote'))).toBeTruthy();
    expect(screen.getByText('Memory')).toBeTruthy();
  });
  it('flags a domain waiting for verification, a missing domain and a nearly full disk', () => {
    const { rerender } = render(
      <HostingInsights
        locale="en"
        site={{ ...base, domains: [{ domain: 'b.com', state: 'pending' }] }}
      />,
    );
    expect(screen.getByText(t('en', 'host.ins.attn.domain', { n: 1 }))).toBeTruthy();
    rerender(<HostingInsights locale="en" site={{ ...base, domains: [] }} />);
    expect(screen.getByText(t('en', 'host.ins.attn.noDomain'))).toBeTruthy();
    rerender(
      <HostingInsights locale="en" site={{ ...base, diskUsedMb: 9500, used: { disk_mb: 9500 } }} />,
    );
    expect(screen.getByText(t('en', 'host.ins.attn.disk', { percent: 93 }))).toBeTruthy();
  });
});
