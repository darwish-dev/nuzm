'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@nuzm/ui';
import { browserApi } from '../lib/client';

/**
 * The organization chip of the top bar, the same height as the balance chips: an icon that opens the workspaces and projects (where a workspace
 * and a project are created) next to the organization switcher.
 */
export function OrgSwitcher(props: {
  label: string;
  current: string;
  orgs: { orgId: string; name: string }[];
  workspacesHref: string;
  workspacesLabel: string;
}) {
  const router = useRouter();
  return (
    <div className="nzc-chip nzc-org">
      <a
        href={props.workspacesHref}
        aria-label={props.workspacesLabel}
        title={props.workspacesLabel}
      >
        <Icon name="organization" size={18} />
      </a>
      <select
        defaultValue={props.current}
        aria-label={props.label}
        onChange={(e) => {
          document.cookie = `nuzm_org=${e.target.value}; path=/; samesite=lax`;
          router.refresh();
        }}
      >
        {props.orgs.map((o) => (
          <option key={o.orgId} value={o.orgId}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function SignOut({ label, to }: { label: string; to: string }) {
  return (
    <button
      type="button"
      className="nz-btn"
      data-variant="secondary"
      onClick={async () => {
        await browserApi().POST('/v1/auth/logout', {});
        window.location.assign(to);
      }}
    >
      {label}
    </button>
  );
}

/**
 * The server resolves the active organization (cookie hint, else the first active membership) but the browser client sends
 * `X-Nuzm-Org` from the `nuzm_org` cookie. A member who never created or switched an organization (an invited user) had no
 * cookie, so every mutation failed with 422. Keep the cookie equal to what the server resolved.
 */
export function ActiveOrgCookie({ orgId }: { orgId: string }) {
  useEffect(() => {
    const current = document.cookie
      .split('; ')
      .find((c) => c.startsWith('nuzm_org='))
      ?.slice('nuzm_org='.length);
    if (current !== orgId) document.cookie = `nuzm_org=${orgId}; path=/; samesite=lax`;
  }, [orgId]);
  return null;
}
