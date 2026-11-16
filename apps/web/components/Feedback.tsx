import type { Notice } from '../lib/actions';

export function NoticeText({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      role={notice.tone === 'error' ? 'alert' : 'status'}
      className={notice.tone === 'error' ? 'nz-error-text' : ''}
    >
      {notice.text}
    </p>
  );
}
