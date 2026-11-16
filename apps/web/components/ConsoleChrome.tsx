'use client';
import { useRouter } from 'next/navigation';
import { browserApi } from '../lib/client';

export function OrgSwitcher(props: {
  label: string;
  current: string;
  orgs: { orgId: string; name: string }[];
}) {
  const router = useRouter();
  return (
    <label>
      <span className="nz-sr">{props.label}</span>
      <select
        className="nz-input"
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
    </label>
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
