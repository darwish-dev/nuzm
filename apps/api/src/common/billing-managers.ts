import type { Db } from '@nuzm/platform';

/** Users who can manage billing in the organization (owners, admins, billing admins): the audience of billing notices. */
export const billingManagerIds = (db: Db, orgId: string): Promise<string[]> =>
  db.withOrg(orgId, async (c) =>
    (
      await c.query<{ user_id: string }>(
        `SELECT DISTINCT m.user_id FROM tenancy.memberships m
           JOIN tenancy.role_permissions rp ON rp.role = m.role AND rp.permission = 'billing:manage'
          WHERE m.org_id = $1`,
        [orgId],
      )
    ).rows.map((r) => r.user_id),
  );
