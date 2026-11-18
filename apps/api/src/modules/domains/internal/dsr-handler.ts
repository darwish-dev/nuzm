import type { FieldCipher } from '../../../common/field-crypto';
import type { DsrHandler, HandlerCtx, HandlerResult } from '../../compliance';
import { openContact } from './contacts';
import type { Row } from './common';

const NA: HandlerResult = { outcome: 'not_applicable', summary: {} };
/** Domain states in which the registrant data must be kept: the registry and the registrar contract require it while the registration exists (HG-04-01: counsel confirms per TLD). */
const RETAINED = ['pending', 'active', 'renewal_at_risk', 'transferring', 'redemption'];

/**
 * DSR hook for registrant contacts (M07 §9, §15). Contacts describe the ORGANIZATION's registrants, so the subject is the organization (`org`); a member or an
 * opaque subject has nothing here. Export decrypts and returns them; erase deletes the contacts of domains that no longer exist (failed, expired) and REFUSES for
 * live registrations with `retention_mandatory` (registry retention rules: documented per TLD, to be confirmed with counsel). Idempotent.
 */
export class DomainContactsDsrHandler implements DsrHandler {
  readonly name = 'domains.contacts';
  readonly datasets = ['domains.domain_contacts'] as const;
  constructor(private readonly cipher: FieldCipher) {}

  async export(ctx: HandlerCtx): Promise<HandlerResult> {
    if (ctx.subject.kind !== 'org') return NA;
    const rows = await ctx.db.withOrg(
      ctx.orgId,
      async (c) =>
        (
          await c.query(
            `SELECT d.name, c.id, c.role, c.payload_enc FROM domains.domain_contacts c JOIN domains.domains d ON d.id = c.domain_id ORDER BY d.name, c.role`,
          )
        ).rows as Row[],
    );
    const data: unknown[] = [];
    for (const r of rows)
      data.push({
        domain: r.name,
        role: r.role,
        contact: await openContact(this.cipher, r.id as string, r.payload_enc as string),
      });
    return { outcome: 'done', summary: { contacts: data.length }, data };
  }

  async erase(ctx: HandlerCtx): Promise<HandlerResult> {
    if (ctx.subject.kind !== 'org') return NA;
    const r = await ctx.db.withOrg(ctx.orgId, async (c) => {
      const del = await c.query(
        `DELETE FROM domains.domain_contacts WHERE domain_id IN (SELECT id FROM domains.domains WHERE state <> ALL($1::text[]))`,
        [RETAINED],
      );
      const kept = (await c.query(`SELECT count(*)::int n FROM domains.domain_contacts`))
        .rows[0] as { n: number };
      return { deleted: del.rowCount ?? 0, kept: kept.n };
    });
    if (r.kept > 0)
      return {
        outcome: 'refused',
        reason: 'retention_mandatory',
        summary: { deleted: r.deleted, retained: r.kept },
      };
    return r.deleted === 0 ? NA : { outcome: 'done', summary: { deleted: r.deleted } };
  }

  async rectify(): Promise<HandlerResult> {
    return { outcome: 'refused', reason: 'unsupported', summary: {} };
  }
}
