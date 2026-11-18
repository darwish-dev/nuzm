import type { Db } from '@nuzm/platform';

/**
 * M12 S55: a verified, ENFORCED enterprise SSO connection owns its email domains. Password and platform-IdP ("social") sign-in for an address at
 * such a domain is refused (`sso_required`); only the connection's own SAML/OIDC flow may authenticate it. Break-glass: organization owners
 * disable enforcement through the connection API (docs/runbooks/sso-lockout.md); platform staff are not covered (they use the admin realm).
 * Returns the connection id, or null when the domain is not enforced.
 */
export async function enforcedConnectionFor(db: Db, email: string): Promise<string | null> {
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  const rows = await db.withAuthScope('sso_lookup', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM identity.sso_connections WHERE enforce AND status = 'active' AND $1 = ANY (verified_domains) LIMIT 1`,
      [domain],
    );
    return rows;
  });
  return rows[0]?.id ?? null;
}
