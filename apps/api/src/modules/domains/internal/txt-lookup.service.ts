import type { Db } from '@nuzm/platform';

/**
 * Read-only TXT lookup in the zones an organization hosts through M07, used by M12 SSO domain proof (docs/04 §2.12: "DNS TXT proof via M07").
 * Returns the TXT values of `fqdn` when one of the organization's ACTIVE zones covers it, or null when none does (the caller then asks public DNS).
 * Our copy of a zone is what the customer sees; the registrar's copy is what is live, so a proof taken from here is only accepted for zones that are
 * not degraded. It never writes.
 */
export class DnsTxtLookup {
  constructor(private readonly db: Db) {}

  async findTxt(orgId: string, fqdnRaw: string): Promise<string[] | null> {
    const fqdn = fqdnRaw.trim().toLowerCase().replace(/\.$/, '');
    return this.db.withOrg(orgId, async (c) => {
      const { rows: zones } = await c.query<{ id: string; name: string }>(
        `SELECT id, lower(name) AS name FROM domains.dns_zones WHERE state = 'active' AND degraded = false
          AND ($1 = lower(name) OR $1 LIKE '%.' || lower(name)) ORDER BY length(name) DESC LIMIT 1`,
        [fqdn],
      );
      const z = zones[0];
      if (!z) return null;
      const rel = fqdn === z.name ? '@' : fqdn.slice(0, fqdn.length - z.name.length - 1);
      const { rows } = await c.query<{ value: unknown }>(
        `SELECT value FROM domains.dns_records WHERE zone_id = $1 AND type = 'TXT' AND lower(name) = $2`,
        [z.id, rel],
      );
      return rows.map((r) => (typeof r.value === 'string' ? r.value : JSON.stringify(r.value)));
    });
  }
}
