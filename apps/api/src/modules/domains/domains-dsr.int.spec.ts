import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '@nuzm/platform';
import { FieldCipher } from '../../common/field-crypto';
import { DB } from '../../common/tokens';
import { DsrRegistry } from '../compliance';
import { DomainContactsDsrHandler } from './internal/dsr-handler';
import { DomainOrderService } from './internal/orders.service';
import { startDomainsKit, type DomainsKit } from './testing/domains-kit';

let k: DomainsKit;
let n = 0;
const nm = (p: string) => `${p}-${Date.now().toString(36)}-${++n}.com`;
const contact = () => ({
  firstName: 'Salem',
  lastName: 'Dsrtest',
  email: 'dsr.person@example.invalid',
  phone: '+966500000000',
  address: { street: 'King Fahd Rd 1', city: 'Riyadh', postalCode: '12211', country: 'SA' },
});

beforeAll(async () => {
  k = await startDomainsKit();
  k.app.get(DomainOrderService).autoKick = false;
  await k.call('alice', 'POST', '/v1/compliance/consents', {
    purposeId: 'domain_registrant_disclosure',
    granted: true,
    localeShown: 'en',
    textVersion: 'placeholder-1',
    subjectRef: 'org',
  });
  await k.fund(k.orgA, '100000000');
});
afterAll(() => k?.close());

describe('DSR hook for registrant contacts (M07 §9, §15)', () => {
  it('is registered in the DSR registry under a valid task name', () => {
    expect(k.app.get(DsrRegistry).get('domain-contacts')).toBeTruthy();
  });
  it('export returns the decrypted contacts of the organization; erase keeps live registrations (retention_mandatory) and deletes the rest', async () => {
    const make = async (name: string) => {
      const q = (
        await k.call('alice', 'POST', '/v1/quotes', {
          kind: 'domain',
          items: [{ name, years: 1, action: 'register' }],
        })
      ).json();
      const r = await k.call('alice', 'POST', '/v1/domains', {
        quoteId: q.id,
        contacts: { registrant: contact() },
      });
      await k.app.get(DomainOrderService).run(k.orgA, r.json().operationId);
      return r.json().domain.id as string;
    };
    const live = await make(nm('dsr-live'));
    const gone = await make(nm('dsr-gone'));
    await k.h.env.sql(
      `UPDATE domains.domains SET state = 'failed', provider_ref = NULL WHERE id = $1`,
      [gone],
    );
    const h = new DomainContactsDsrHandler(k.app.get(FieldCipher));
    const ctx = {
      orgId: k.orgA,
      subject: { kind: 'org' as const },
      now: new Date(),
      db: k.app.get<Db>(DB),
    };
    const ex = await h.export(ctx);
    expect(ex.outcome).toBe('done');
    const data = (ex as { data: { domain: string; role: string; contact: { email: string } }[] })
      .data;
    expect(data.length).toBeGreaterThanOrEqual(8);
    expect(data[0]!.contact.email).toBe('dsr.person@example.invalid');
    const er = await h.erase(ctx);
    expect(er).toMatchObject({ outcome: 'refused', reason: 'retention_mandatory' });
    expect(
      await k.count(`SELECT count(*) n FROM domains.domain_contacts WHERE domain_id = $1`, [gone]),
    ).toBe(0);
    expect(
      await k.count(`SELECT count(*) n FROM domains.domain_contacts WHERE domain_id = $1`, [live]),
    ).toBe(4);
    // a member (not the organization) has nothing here
    expect(
      (await h.export({ ...ctx, subject: { kind: 'member', userId: k.ids.alice! } })).outcome,
    ).toBe('not_applicable');
    // an idempotent second erase changes nothing
    expect(await h.erase(ctx)).toMatchObject({ outcome: 'refused' });
  });
});
