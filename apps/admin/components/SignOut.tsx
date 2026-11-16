'use client';
import { browserApi } from '../lib/client';

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
