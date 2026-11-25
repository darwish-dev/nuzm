import { describe, expect, it } from 'vitest';
import { networkBody } from './provider-network';

describe('provisioning network body', () => {
  it('builds the Alibaba body for a Saudi region, trimming and dropping empty optional fields', () => {
    expect(
      networkBody('alibaba', ' ME-central-1 ', {
        vSwitchId: ' vsw-abc123 ',
        securityGroupId: 'sg-1a2b',
        zoneId: '',
      }),
    ).toEqual({
      ok: true,
      region: 'me-central-1',
      body: { vSwitchId: 'vsw-abc123', securityGroupId: 'sg-1a2b' },
    });
  });
  it('Huawei needs VPC, subnet and security group; the project id is optional', () => {
    const v = { vpcId: 'vpc-001', subnetId: 'sub-001', securityGroupId: 'sg-001' };
    expect(networkBody('huawei', 'me-east-1', { ...v, projectId: 'p0123456789' })).toMatchObject({
      ok: true,
      body: { projectId: 'p0123456789' },
    });
    expect(networkBody('huawei', 'me-east-1', { ...v, vpcId: '' })).toEqual({
      ok: false,
      error: 'field',
    });
  });
  it('refuses a bad region, a bad id and an unknown provider', () => {
    expect(networkBody('alibaba', 'ME Central', {})).toEqual({ ok: false, error: 'region' });
    expect(networkBody('contabo', 'eu', {})).toEqual({ ok: false, error: 'region' });
    expect(
      networkBody('alibaba', 'me-central-1', { vSwitchId: 'a b', securityGroupId: 'sg-1a2b' }),
    ).toEqual({ ok: false, error: 'field' });
  });
});
