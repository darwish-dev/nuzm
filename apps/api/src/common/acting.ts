import type { AccessContext } from './access';

/** What the access guard asks of the delegated-access service (M11 S54). The guard depends on this token, not on the programs module. */
export interface ActingInput {
  userId: string;
  /** The agency organization the caller is a MEMBER of (verified by the guard from the membership). */
  agencyOrgId: string;
  agencyOrgStatus: string;
  agencyMemberPermissions: ReadonlySet<string>;
  /** `X-Nuzm-Acting-Org`: the client organization. Untrusted input until the service says otherwise. */
  clientOrgId: string;
  needed: string;
}
export abstract class ActingOrgPort {
  abstract authorize(i: ActingInput): Promise<AccessContext>;
}
