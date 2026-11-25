import { describe, expect, it } from 'vitest';
import {
  HestiaSiteOps,
  SiteOpsUncertain,
  certificateToken,
  type HostingAdapterSubset,
  type OpResult,
} from './hestia-site-ops';
import type { TargetSite } from './ports';

const site: TargetSite = {
  id: 'site-1',
  name: 's-abc',
  status: 'active',
  runtime: 'static',
  dataRegion: 'local',
  domain: null,
};
type Find = Awaited<ReturnType<HostingAdapterSubset['findByToken']>>;
type Cert = Awaited<ReturnType<HostingAdapterSubset['issueCertificate']>>;
function adapter(find: Find, cert: Cert) {
  const calls: { op: string; args: unknown[] }[] = [];
  const a: HostingAdapterSubset<{ trace: string }, { node: string }> = {
    async findByToken(...args) {
      calls.push({ op: 'find', args });
      return find;
    },
    async issueCertificate(...args) {
      calls.push({ op: 'cert', args });
      return cert;
    },
  };
  return { a, calls };
}
const bind = async () => ({ ctx: { trace: 't' }, node: { node: 'n1' }, siteName: 's-abc' });
const info = { name: 's-abc', suspended: false, domains: ['a.example'] };
const ok = <T>(data: T): OpResult<T> => ({ status: 'succeeded', data });

describe('HestiaSiteOps over the HostingAdapter surface', () => {
  it('a found site exists; suspended is carried', async () => {
    const { a, calls } = adapter(ok(info), ok({ certId: 'c', notAfter: 'x', domains: [] }));
    const ops = new HestiaSiteOps(a, bind, () => 'op-1');
    expect(await ops.siteState(site)).toEqual({ exists: true, suspended: false });
    const s2 = new HestiaSiteOps(
      adapter(ok({ ...info, suspended: true }), ok({ certId: 'c', notAfter: 'x', domains: [] })).a,
      bind,
      () => 'op',
    );
    expect(await s2.siteState(site)).toEqual({ exists: true, suspended: true });
    expect(calls[0]).toMatchObject({ op: 'find' });
    expect(calls[0]!.args[2]).toBe('s-abc');
  });
  it('provably absent (succeeded with null) is missing; another organization (no binding) is missing too', async () => {
    const { a } = adapter(ok(null), ok({ certId: 'c', notAfter: 'x', domains: [] }));
    expect(await new HestiaSiteOps(a, bind, () => 'o').siteState(site)).toEqual({
      exists: false,
      suspended: false,
    });
    expect(
      await new HestiaSiteOps(
        a,
        async () => null,
        () => 'o',
      ).siteState(site),
    ).toEqual({ exists: false, suspended: false });
  });
  it('uncertain or failed is NEVER read as absent: it throws so the caller reconciles first', async () => {
    const unc = adapter({ status: 'uncertain' }, ok({ certId: 'c', notAfter: 'x', domains: [] }));
    await expect(new HestiaSiteOps(unc.a, bind, () => 'o').siteState(site)).rejects.toBeInstanceOf(
      SiteOpsUncertain,
    );
    const failed = adapter(
      { status: 'failed', error: { category: 'auth' } },
      ok({ certId: 'c', notAfter: 'x', domains: [] }),
    );
    await expect(new HestiaSiteOps(failed.a, bind, () => 'o').siteState(site)).rejects.toThrow(
      'auth',
    );
    const odd = adapter({ status: 'accepted' }, ok({ certId: 'c', notAfter: 'x', domains: [] }));
    await expect(new HestiaSiteOps(odd.a, bind, () => 'o').siteState(site)).rejects.toBeInstanceOf(
      SiteOpsUncertain,
    );
  });
  it('a managed certificate is requested with a deterministic token, and only managed mode', async () => {
    const { a, calls } = adapter(
      ok(info),
      ok({
        certId: 'c',
        notAfter: '2027-03-01T00:00:00.000Z',
        domains: ['b.example', 'a.example'],
      }),
    );
    const ops = new HestiaSiteOps(a, bind, () => 'op-9');
    const r = await ops.issueManagedCertificate(site, ['b.example', 'a.example']);
    expect(r).toEqual({
      notAfter: '2027-03-01T00:00:00.000Z',
      domains: ['b.example', 'a.example'],
    });
    const c = calls.find((x) => x.op === 'cert')!;
    expect(c.args[3]).toEqual({ domains: ['b.example', 'a.example'], mode: 'managed' });
    expect(c.args[4]).toEqual({
      idempotencyToken: certificateToken('site-1', ['A.example', 'b.example']),
      operationId: 'op-9',
    });
  });
  it('certificate: uncertain reconciles, failure and empty domain lists are refused', async () => {
    const unc = adapter(ok(info), { status: 'uncertain' });
    await expect(
      new HestiaSiteOps(unc.a, bind, () => 'o').issueManagedCertificate(site, ['a.example']),
    ).rejects.toBeInstanceOf(SiteOpsUncertain);
    const failed = adapter(ok(info), { status: 'failed', error: { category: 'quota' } });
    await expect(
      new HestiaSiteOps(failed.a, bind, () => 'o').issueManagedCertificate(site, ['a.example']),
    ).rejects.toThrow('quota');
    await expect(
      new HestiaSiteOps(failed.a, bind, () => 'o').issueManagedCertificate(site, []),
    ).rejects.toThrow();
    await expect(
      new HestiaSiteOps(
        failed.a,
        async () => null,
        () => 'o',
      ).issueManagedCertificate(site, ['a.example']),
    ).rejects.toThrow('does not exist');
  });
});
